/* ==================================================================
   PBP — ESPN play-by-play reconstruction library (Tier 2 of the
   boundary-based Live Coaching scoring model).

   Purpose: given an ESPN `summary?event=` payload, reconstruct a
   player's cumulative fantasy-relevant stat line at an arbitrary
   normalized game-clock boundary (0..1 of the scheduled 60 minutes).

   Attribution rule: a play belongs to the segment in which it was
   SNAPPED — production from a play snapped at or after the boundary
   counts as post-boundary. Plays nullified by penalty ("No Play") are
   excluded. Two-point conversion attempts are ignored (consistent with
   the scoring engine) but the touchdown that precedes one in the same
   text is credited. Overtime elapsed time runs past 1.0 (3600s + OT).

   ESPN text quirks this parser handles (found empirically via the
   probe against 2025 week 1):
   - TD play and the extra point merged into one text: both credited,
     the XP to the kicker named right before "extra point".
   - TD play followed by "TWO-POINT CONVERSION ATTEMPT ...": the TD
     counts, the conversion is dropped.
   - Scoring-summary-format lines ("J.Jefferson 13 Yd pass from
     J.McCarthy (...)") that are sometimes a TD's only record; deduped
     against normal-format plays at the same period+clock.
   - Same-initial name collisions (T.Etienne twice in one game)
     resolved by the drive's offensive team.
   - Fumble "lost" requires the recovering team (GSIS abbr, e.g. BLT)
     to differ from the carrier's team (ESPN abbr, e.g. BAL).

   Exposed as window.PBP. No dependencies.
   ================================================================== */
(function () {
  'use strict';

  // GSIS-style team abbreviations (used inside play text) vs ESPN's box
  // score abbreviations (LA/WAS in text vs LAR/WSH in the box)
  const ABBR_FIX = { BLT: 'BAL', ARZ: 'ARI', CLV: 'CLE', HST: 'HOU', LA: 'LAR', WAS: 'WSH' };
  const normTeam = (t) => { const u = String(t || '').toUpperCase(); return ABBR_FIX[u] || u; };

  // ---- clock helpers ----
  function clockToSeconds(display) {
    const m = String(display || '').match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  // elapsed seconds at snap; regulation quarters are 900s, OT periods 600s
  function playElapsedSec(play) {
    const p = play.period && play.period.number;
    const rem = clockToSeconds(play.clock && play.clock.displayValue);
    if (!p || rem == null) return null;
    if (p <= 4) return (p - 1) * 900 + (900 - rem);
    return 3600 + (p - 5) * 600 + (600 - rem);
  }

  // ---- flatten all plays from summary.drives ----
  function allPlays(summary) {
    const out = [];
    const drives = summary.drives || {};
    const lists = [...(drives.previous || [])];
    if (drives.current) lists.push(drives.current);
    for (const d of lists) {
      const off = normTeam(d.team && d.team.abbreviation);
      for (const pl of d.plays || []) {
        if (off && !pl._offense) pl._offense = off;
        out.push(pl);
      }
    }
    // some payloads also expose summary.plays directly
    if (!out.length && Array.isArray(summary.plays)) out.push(...summary.plays);
    const seen = new Set();
    const uniq = [];
    for (const pl of out) {
      const id = pl.id || `${pl.period?.number}:${pl.clock?.displayValue}:${pl.text}`;
      if (seen.has(id)) continue;
      seen.add(id);
      uniq.push(pl);
    }
    uniq.sort((a, b) => (playElapsedSec(a) ?? 0) - (playElapsedSec(b) ?? 0));
    return uniq;
  }

  // ---- name matching: box-score athletes -> patterns used in play text ----
  function nameKey(s) {
    return String(s || '').toLowerCase().replace(/[^a-z\-'. ]/g, '').trim();
  }
  // "Patrick Mahomes" -> ["p.mahomes", "pa.mahomes", "pat.mahomes",
  // "patrick mahomes", "mahomes"] — ESPN disambiguates shared initials with
  // longer prefixes (Ty.Johnson, Mi.Wilson, Cas.Washington). The bare
  // surname must stay LAST: buildMatcher drops it on surname collisions.
  function patternsFor(fullName) {
    const clean = String(fullName || '').replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '').trim();
    const parts = clean.split(/\s+/);
    if (parts.length < 2) return [nameKey(clean)];
    const first = parts[0];
    const last = parts.slice(1).join(' ');
    const pats = [];
    for (const n of [1, 2, 3]) {
      if (first.length >= n) pats.push(nameKey(`${first.slice(0, n)}.${last}`));
    }
    pats.push(nameKey(clean));
    pats.push(nameKey(last));
    return [...new Set(pats)];
  }

  // Build a matcher from summary.boxscore.players so reconstruction uses
  // the same identities as the official box score.
  function buildMatcher(summary) {
    const entries = []; // {id, name, team, patterns}
    for (const teamBlock of (summary.boxscore && summary.boxscore.players) || []) {
      const team = normTeam(teamBlock.team && teamBlock.team.abbreviation);
      for (const cat of teamBlock.statistics || []) {
        for (const a of cat.athletes || []) {
          if (!a.athlete) continue;
          const id = String(a.athlete.id);
          if (entries.some((e) => e.id === id)) continue;
          entries.push({ id, name: a.athlete.displayName, team, patterns: patternsFor(a.athlete.displayName) });
        }
      }
    }
    // last-name-only patterns are ambiguous only when two players on the
    // SAME team share the surname — cross-team duplicates are resolved by
    // the drive's offense at match time
    const lastCounts = {};
    for (const e of entries) {
      const k = `${e.team}|${e.patterns[e.patterns.length - 1]}`;
      lastCounts[k] = (lastCounts[k] || 0) + 1;
    }
    for (const e of entries) {
      const k = `${e.team}|${e.patterns[e.patterns.length - 1]}`;
      if (e.patterns.length > 1 && lastCounts[k] > 1) e.patterns = e.patterns.slice(0, -1);
    }
    return entries;
  }

  // find the athlete whose pattern appears at `textKey.slice(idx)`. When the
  // drive's offense is known, ONLY that team's players are candidates — a
  // ball-carrier, receiver, passer, or kicker is never on defense, and the
  // defenders named in tackle notes must never match (that is how
  // "D.Jones (IND QB)" vs "D.J. Jones (DEN DT)" and "M.Brown" with two
  // Browns in the game get resolved).
  function matchAt(entries, textKey, idx, offense) {
    let best = null;
    for (const e of entries) {
      if (offense && e.team !== offense) continue;
      for (const p of e.patterns) {
        if (textKey.startsWith(p, idx)) {
          if (!best || p.length > best.len) best = { id: e.id, len: p.length };
        }
      }
    }
    return best;
  }
  function firstMatch(entries, textKey, fromIdx, offense) {
    for (let i = fromIdx; i < textKey.length; i++) {
      const m = matchAt(entries, textKey, i, offense);
      if (m) return { ...m, idx: i };
    }
    return null;
  }
  // the athlete whose pattern ENDS the given prefix (name immediately before
  // a marker like " pass " / "extra point" / "yard field goal") — avoids
  // grabbing an unrelated name earlier in the text; offense-restricted like
  // matchAt when the offense is known
  function matchEnding(entries, pre, offense) {
    const s = String(pre || '').replace(/[\s.]+$/, '');
    let best = null;
    for (const e of entries) {
      if (offense && e.team !== offense) continue;
      for (const p of e.patterns) {
        if (!s.endsWith(p)) continue;
        const i = s.length - p.length;
        if (i > 0 && s[i - 1] !== ' ' && s[i - 1] !== '.') continue;
        if (!best || p.length > best.len) best = { id: e.id, len: p.length };
      }
    }
    return best;
  }
  // Ball-carriers are ANCHORED: the rusher opens the text, the receiver
  // directly follows " to ". Match only within a short window from that
  // anchor so tacklers named later can never be grabbed. Two tiers: the
  // drive's offense first, then any team — ESPN occasionally files a play
  // under the wrong drive, and the unrestricted-but-anchored tier recovers
  // it without opening the door to defenders in tackle notes.
  function windowMatch(entries, textKey, from, span, offense) {
    const lim = Math.min(textKey.length, from + span);
    for (let i = from; i < lim; i++) {
      const m = matchAt(entries, textKey, i, offense);
      if (m) return { ...m, idx: i };
    }
    return null;
  }
  const anchorMatch = (entries, textKey, from, span, offense) =>
    windowMatch(entries, textKey, from, span, offense) || windowMatch(entries, textKey, from, span, null);

  // yardline reference -> distance from the offense's own goal line
  function spotPos(team, n, offense) {
    if (!team) return 50;
    return normTeam(team) === offense ? Number(n) : 100 - Number(n);
  }
  // An accepted penalty on the OFFENSE enforced at an in-play spot (the play
  // stands — no "No Play") truncates the gain at the spot of the foul, and a
  // nullified touchdown is enforced the same way:
  // counted = enforcement spot − start of play.
  function penaltyClipYds(seg, yds, wasTd, offense) {
    if (yds == null || yds <= 0 || !offense) return yds;
    // tempered: crosses the dots in player initials ("LV-J.Bech,") but can
    // never bridge from a declined penalty into a later clause's "enforced"
    const re = /penalty on ([a-z]{2,4})-(?:(?!penalty on)[\s\S])*?enforced (at [^.]*?)(?=\.|$)/g;
    let m;
    while ((m = re.exec(seg))) {
      if (normTeam(m[1]) !== offense) continue;
      if (/between downs/.test(m[2])) continue;
      const spot = m[2].match(/at (?:([a-z]{2,4}) )?(\d+)/);
      if (!spot) continue;
      let endPos;
      if (wasTd) endPos = 100;
      else {
        const ends = [...seg.matchAll(/(?:to|at) (?:([a-z]{2,4}) )?(\d+) for /g)];
        if (!ends.length) return yds;
        const e = ends[ends.length - 1];
        endPos = spotPos(e[1], e[2], offense);
      }
      const enfPos = spotPos(spot[1], spot[2], offense);
      return Math.max(0, Math.min(yds, enfPos - (endPos - yds)));
    }
    return yds;
  }

  // ---- per-play stat extraction (fantasy-relevant only) ----
  const zero = () => ({
    passYds: 0, passTD: 0, passInt: 0, passComp: 0, passAtt: 0,
    rushYds: 0, rushTD: 0, rushAtt: 0,
    rec: 0, recYds: 0, recTD: 0,
    fumLost: 0, fgMade: 0, fgAtt: 0, fgBonus: 0, xpMade: 0, xpAtt: 0,
  });

  // dedupe key so a TD recorded both as a normal play and as a
  // scoring-summary line is credited once
  const tdKey = (play, id) => `${play.period?.number}:${play.clock?.displayValue}:${id}`;
  // scoring-summary-format line ("<Scorer> 13 Yd pass from <Passer>",
  // "Cam Little 47 Yd Field Goal") — settled AFTER normal plays so the
  // dedupe never depends on feed ordering
  const isSummaryLine = (pl) => {
    const t = String(pl.text || '');
    return /\d+\s*yd (?:pass from|run\b|rush\b)/i.test(t)
      || (/\d+\s*(?:yd|yard) field goal/i.test(t) && !/is good|no good|blocked|missed|wide/i.test(t));
  };

  // Returns a branch label describing how the play was classified — used by
  // tracePlays() for diagnostics; reconstructAt() ignores it.
  // ctx (optional) carries the TD dedupe set within one reconstruction pass.
  function creditPlay(play, entries, acc, ctx) {
    return creditText(String(play.text || ''), play, entries, acc, ctx);
  }

  function creditText(text, play, entries, acc, ctx) {
    const offense = play._offense || null;
    const low = text.toLowerCase();

    // administrative prefix "<OL> reported in as eligible." — the names in it
    // are not the ball-carrier; parse only what follows the last occurrence
    const elig = low.lastIndexOf('reported in as eligible.');
    if (elig >= 0) return creditText(text.slice(elig + 24), play, entries, acc, ctx);

    // "Direct snap to X." preamble: the snap recipient is not necessarily
    // the ball-carrier — parse the sentence that follows it
    const dsm = low.match(/direct snap to .*?\.(?=\s)/);
    if (dsm) return creditText(text.slice(dsm.index + dsm[0].length), play, entries, acc, ctx);

    // a two-point attempt never counts, but the TD before it in the same
    // text does — truncate and recurse on the part before the marker
    const tpIdx = (() => { const i = low.indexOf('two-point'); return i >= 0 ? i : low.indexOf('two point'); })();
    if (tpIdx >= 0) {
      const base = text.slice(0, tpIdx).replace(/\(\s*$/, '');
      if (!base.trim()) return 'two-point';
      return (creditText(base, play, entries, acc, ctx) || 'two-point') + '~2pt-dropped';
    }
    // replay review overturned the call: only the text AFTER the last
    // "REVERSED." describes what actually happened ("Upheld" is untouched)
    const rev = low.lastIndexOf('reversed.');
    if (rev >= 0 && text.slice(rev + 9).trim()) {
      return (creditText(text.slice(rev + 9), play, entries, acc, ctx) || 'other') + '~reversed';
    }
    if (/no play/i.test(low)) {
      // A change of possession can survive a penalty that nullifies the rest
      // of the play: when the defense recovered a fumble BEFORE the penalty
      // text, the box score still charges the fumble to the carrier (e.g. a
      // strip-sack whose return was wiped by a flag).
      const fi = low.search(/fumbles/);
      const ri = low.search(/recovered by [a-z]{2,4}-/);
      const pi = low.search(/penalty/);
      if (fi >= 0 && ri > fi && (pi < 0 || ri < pi)) {
        // The turnover survives the flag only when the penalty is ON the
        // recovering team and is a RETURN-phase foul (a block or roughness
        // after the recovery). A play-phase foul (defensive holding,
        // offside, ...) wipes the fumble with the rest of the play.
        const recTeam = (low.match(/recovered by ([a-z]{2,4})-/) || [])[1];
        const penTeam = pi >= 0 ? (low.slice(pi).match(/penalty on ([a-z]{2,4})-/) || [])[1] : null;
        const returnFoul = pi >= 0
          && /illegal block|unnecessary roughness|unsportsmanlike|face mask|horse collar|taunting/.test(low.slice(pi));
        // ...or the flag is walked off against the recovering team in their
        // OWN territory (the possession change stood; only the return was
        // penalized) — vs. a play-phase foul enforced back at the original
        // offense's spot, which wipes the turnover with the play
        const enfTeam = pi >= 0 ? (low.slice(pi).match(/enforced at ([a-z]{2,4}) \d+/) || [])[1] : null;
        const stood = recTeam && penTeam && normTeam(recTeam) === normTeam(penTeam)
          && (returnFoul || (enfTeam && normTeam(enfTeam) === normTeam(penTeam)));
        if (pi < 0 || stood) {
          fumbleCheck(low, nameKey(text), entries, acc, null, offense);
          return 'no-play+fumble';
        }
      }
      return 'no-play';            // nullified by penalty
    }
    if (/spiked the ball/.test(low)) return 'spike';

    // `key` (digits stripped) is only for NAME matching; every numeric or
    // phrase predicate parses `low`, which keeps digits.
    const key = nameKey(text);
    // "TOUCHDOWN NULLIFIED by Penalty": no score — the yards are clipped at
    // the enforcement spot by penaltyClipYds. And a TD whose text has a
    // FUMBLE before it belongs to the defender who returned it, never to
    // the offense.
    const hadTd = /touchdown/.test(low);
    const nullified = /touchdown nullified/.test(low);
    const fumIdx = low.search(/fumbles/);
    const td = hadTd && !nullified && !(fumIdx >= 0 && fumIdx < low.indexOf('touchdown'));
    const get = (id) => (acc[id] ||= zero());
    const ydsMatch = (seg = low) => {
      let m = seg.match(/for (-?\d+) (?:yards?|yds?)\b/);
      if (m) return Number(m[1]);
      m = seg.match(/for a loss of (\d+) (?:yards?|yds?)\b/);
      if (m) return -Number(m[1]);
      if (/for no gain/.test(seg)) return 0;
      return null;
    };

    // TD play with the extra point merged into the same text: split at the
    // end of the TOUCHDOWN sentence, credit both halves. (hadTd, not td: a
    // defensive return TD's extra point is real even though the offense
    // gets no touchdown credit.)
    const xpIdx = low.indexOf(' extra point');
    if (hadTd && !nullified && xpIdx > 0) {
      const tdDot = low.indexOf('.', low.indexOf('touchdown'));
      if (tdDot > 0 && tdDot < xpIdx) {
        creditText(text.slice(tdDot + 1), play, entries, acc, ctx);
        return (creditText(text.slice(0, tdDot + 1), play, entries, acc, ctx) || 'td') + '+xp';
      }
    }

    // scoring-summary format: "<Receiver> 13 Yd pass from <Passer> (...)"
    let sm = low.match(/(\d+)\s*yd pass from /);
    if (sm) {
      const receiver = firstMatch(entries, key, 0, offense);
      const fromIdx = key.indexOf(' from ');
      const passer = fromIdx >= 0 ? firstMatch(entries, key, fromIdx + 6, offense) : null;
      if (!receiver || !passer) return 'score-summary-miss';
      if (ctx && ctx.td.has(tdKey(play, receiver.id))) return 'score-summary-dup';
      if (ctx) ctx.td.add(tdKey(play, receiver.id));
      const yds = Number(sm[1]);
      const p = get(passer.id);
      p.passAtt++; p.passComp++; p.passYds += yds; p.passTD++;
      const r = get(receiver.id);
      r.rec++; r.recYds += yds; r.recTD++;
      kickTail(low, play, entries, acc, ctx);
      return 'score-summary-pass';
    }
    sm = low.match(/(\d+)\s*yd (?:run|rush)\b/);
    if (sm) {
      const rusher = firstMatch(entries, key, 0, offense);
      if (!rusher) return 'score-summary-miss';
      if (ctx && ctx.td.has(tdKey(play, rusher.id))) return 'score-summary-dup';
      if (ctx) ctx.td.add(tdKey(play, rusher.id));
      const r = get(rusher.id);
      r.rushAtt++; r.rushYds += Number(sm[1]); r.rushTD++;
      kickTail(low, play, entries, acc, ctx);
      return 'score-summary-rush';
    }

    // field goals / extra points — the kicker is the name immediately
    // before the marker (firstMatch could grab a tackler or penalized
    // player named earlier in the text)
    const fgAt = key.search(/ (?:yard|yd) field goal/);
    if (fgAt >= 0) {
      const kicker = matchEnding(entries, key.slice(0, fgAt), offense) || firstMatch(entries, key, 0, offense);
      const dist = (low.match(/(\d+)\s*(?:yard|yd) field goal/) || [])[1];
      if (!kicker) return 'fg-nokicker';
      // scoring-summary form ("Cam Little 47 Yd Field Goal") has no verdict
      // text — scoring plays only list makes, so it IS a make
      const summaryForm = !/is good|no good|blocked|missed|wide/.test(low)
        && /(?:yard|yd) field goal\s*\.?\s*$/.test(low);
      const made = /is good/.test(low) || summaryForm;
      if (made && ctx) {
        const dk = tdKey(play, kicker.id) + ':fg';
        if (ctx.td.has(dk)) return 'fg-dup';
        ctx.td.add(dk);
      }
      const k = get(kicker.id);
      k.fgAtt++;
      if (made) {
        k.fgMade++;
        const d = Number(dist) || 0;
        if (d >= 50) k.fgBonus += 2; else if (d >= 40) k.fgBonus += 1;
      }
      return 'fg';
    }
    if (xpIdx >= 0) {
      // NOT offense-restricted: after a punt/kick RETURN touchdown the play
      // sits in the kicking team's drive but the XP belongs to the scoring
      // (receiving) team's kicker. matchEnding's anchoring (the name right
      // before "extra point") is the safety here, not the team filter.
      const kicker = (xpIdx > 0 && matchEnding(entries, key.slice(0, key.indexOf(' extra point')), null))
        || firstMatch(entries, key, 0, null);
      if (!kicker) return 'xp-nokicker';
      const k = get(kicker.id);
      k.xpAtt++;
      if (/is good/.test(low)) k.xpMade++;
      return 'xp';
    }
    // kicks and punts (word-boundaried: "R.Wright" must not match "right").
    // Returns carry no offensive stats, but a returner's lost fumble or muff
    // does count against them.
    if (/\b(kicks|punts|kickoff|punt)\b/.test(low) && !/\b(pass|rush|rushes|left|right|middle|scrambles)\b/.test(low)) {
      if (/fumbles|muffs/.test(low)) {
        // never the "Center-X"/"Holder-X" annotations; a muff anchors to the
        // name immediately before "MUFFS"
        const cleanKey = key.replace(/\b(?:center|holder)-[a-z'.\-]+/g, ' ');
        const mi = cleanKey.indexOf(' muffs');
        let returner = mi > 0 ? matchEnding(entries, cleanKey.slice(0, mi), null) : null;
        if (!returner) {
          const km = cleanKey.search(/\b(?:kicks|punts)\b/);
          returner = firstMatch(entries, cleanKey, km >= 0 ? km + 6 : 0, null);
        }
        if (returner) fumbleCheck(low, key, entries, acc, returner.id, offense);
      }
      // return-TD summary lines ride the kick branch but still carry a real
      // extra point in their "(<Kicker> Kick)" tail
      kickTail(low, play, entries, acc, ctx);
      return 'kick';
    }

    // passes — the passer is the name immediately before " pass ", the
    // receiver follows the first " to " AFTER it (a botched-snap preamble
    // like "C.Humphrey ... recovered by KC-P.Mahomes" must not be matched)
    if (/ pass /.test(low) || /^(\(.*?\)\s*)?\S+.*? pass(ed)? /.test(low)) {
      const kp = key.indexOf(' pass ');
      // anchored only — never scan the whole text (a tackler must not
      // become the passer when the drive's offense label is wrong)
      const passer = kp > 0
        ? (matchEnding(entries, key.slice(0, kp), offense) || matchEnding(entries, key.slice(0, kp), null))
        : anchorMatch(entries, key, 0, 30, offense);
      if (!passer) return 'pass-no-passer';
      const p = get(passer.id);
      if (/intercepted/.test(low)) { p.passAtt++; p.passInt++; return 'pass-int'; }
      if (/incomplete/.test(low)) { p.passAtt++; return 'pass-incomplete'; }
      const toIdx = key.indexOf(' to ', kp >= 0 ? kp : 0);
      const receiver = toIdx >= 0 ? anchorMatch(entries, key, toIdx + 4, 16, offense) : null;
      // yardage and penalty clipping read only the text from " pass " on —
      // a botched-snap preamble's "for -5 yards" must not be the reception
      const lowKp = low.indexOf(' pass ');
      const passSeg = lowKp >= 0 ? low.slice(lowKp) : low;
      let yds = ydsMatch(passSeg);
      if (yds == null) { // completed but yardage not parseable (rare)
        p.passAtt++; p.passComp++;
        return 'pass-no-yds';
      }
      yds = penaltyClipYds(passSeg, yds, hadTd, offense);
      p.passAtt++; p.passComp++; p.passYds += yds;
      let carrier = receiver ? receiver.id : passer.id;
      let scorer = receiver;
      if (receiver) {
        const r = get(receiver.id);
        r.rec++; r.recYds += yds;
      }
      // laterals: each "Lateral to <X> ... for N yards" adds N to the
      // passer's passing yards and X's receiving yards (no extra reception);
      // the TD and any fumble belong to the FINAL carrier
      if (/ lateral to /.test(low)) {
        for (const seg of text.split(/lateral to /i).slice(1)) {
          const lm = firstMatch(entries, nameKey(seg), 0, offense);
          const ym = seg.toLowerCase().match(/for (-?\d+) (?:yards?|yds?)\b/);
          if (lm && ym) {
            const y2 = Number(ym[1]);
            p.passYds += y2;
            get(lm.id).recYds += y2;
            carrier = lm.id;
            scorer = lm;
          }
        }
      }
      if (td) {
        p.passTD++;
        if (scorer) {
          get(scorer.id).recTD++;
          if (ctx) ctx.td.add(tdKey(play, scorer.id));
        }
      }
      fumbleCheck(low, key, entries, acc, carrier, offense);
      return receiver ? 'pass' : 'pass-no-receiver';
    }

    // sacks: no fantasy-relevant offense stats in our model
    if (/sacked/.test(low)) {
      const qb = anchorMatch(entries, key, 0, 30, offense);
      fumbleCheck(low, key, entries, acc, qb ? qb.id : null, offense);
      return 'sack';
    }

    // rushes (incl. scrambles and kneels; word-boundaried keywords).
    // The rusher opens the text: anchored window only, so a tackler in the
    // parentheses can never be the ball-carrier.
    if (/\b(left|right|middle|end|guard|tackle|scrambles?|kneels?|rush|rushes|rushed)\b/.test(low)) {
      const rusher = anchorMatch(entries, key, 0, 30, offense);
      let yds = ydsMatch();
      if (!rusher) return 'rush-no-rusher';
      if (yds == null) {
        // an aborted snap still loses the ball ("C.Rush FUMBLES (Aborted)...")
        fumbleCheck(low, key, entries, acc, rusher.id, offense);
        return 'rush-no-yds';
      }
      yds = penaltyClipYds(low, yds, hadTd, offense);
      const r = get(rusher.id);
      r.rushAtt++; r.rushYds += yds;
      if (td) { r.rushTD++; if (ctx) ctx.td.add(tdKey(play, rusher.id)); }
      fumbleCheck(low, key, entries, acc, rusher.id, offense);
      return 'rush';
    }
    // aborted snaps etc.: a fumble can occur on an otherwise unclassified play
    if (/fumbles/.test(low)) {
      fumbleCheck(low, key, entries, acc, null, offense);
      kickTail(low, play, entries, acc, ctx);
      return 'fumble';
    }
    // defensive/return TD summary lines ("R.Smith 63 Yd Fumble Return
    // (T.Loop Kick)") carry no offense stats but a real extra point
    kickTail(low, play, entries, acc, ctx);
    return 'other';
  }

  // "(<Kicker> Kick)" tail on scoring-summary lines — a real extra point.
  // Not offense-restricted: on a defensive TD the kicker is on the other
  // side of the drive's offense. Deduped per period+clock+kicker.
  function kickTail(low, play, entries, acc, ctx) {
    const m = low.match(/\(([a-z\-'. ]+?) kick\)/);
    if (!m) return;
    const kicker = matchEnding(entries, nameKey(m[1]), null);
    if (!kicker) return;
    if (ctx) {
      const dk = tdKey(play, kicker.id) + ':xp';
      if (ctx.td.has(dk)) return;
      ctx.td.add(dk);
    }
    const k = (acc[kicker.id] ||= zero());
    k.xpAtt++; k.xpMade++;
  }

  function fumbleCheck(low, key, entries, acc, carrierId, offense) {
    if (!/fumbles|muffs/.test(low)) return;
    const found = carrierId ? { id: carrierId } : anchorMatch(entries, key, 0, 30, offense);
    const who = found && entries.find((e) => e.id === found.id);
    if (!who) return;
    // lost only if the RECOVERING team differs from the carrier's team;
    // play text uses GSIS abbreviations ("recovered by BLT-M.Humphrey")
    const rec = low.match(/recovered by ([a-z]{2,4})-/);
    const lost = rec ? normTeam(rec[1]) !== who.team : /touchback/.test(low);
    if (lost) (acc[who.id] ||= zero()).fumLost++;
  }

  // ---- public API ----
  // cumulative fantasy stat lines for every box-score athlete, counting
  // only plays snapped STRICTLY BEFORE boundary (boundary in [0, 1+], 1 = 60:00).
  // Normal-format plays run first, scoring-summary-format lines second so the
  // TD dedupe never depends on feed ordering.
  function reconstructAt(summary, boundary) {
    const entries = buildMatcher(summary);
    const acc = {};
    const ctx = { td: new Set() };
    const inCut = [];
    for (const play of allPlays(summary)) {
      const el = playElapsedSec(play);
      if (el == null) continue;
      if (el / 3600 >= boundary) continue;
      inCut.push(play);
    }
    for (const play of inCut) if (!isSummaryLine(play)) creditPlay(play, entries, acc, ctx);
    for (const play of inCut) if (isSummaryLine(play)) creditPlay(play, entries, acc, ctx);
    return acc; // { athleteId: statLine }
  }

  // production occurring at/after the boundary = full - before
  function statsAfterBoundary(summary, athleteId, boundary) {
    const before = reconstructAt(summary, boundary)[athleteId] || zero();
    const full = reconstructAt(summary, 99)[athleteId] || zero();
    const out = zero();
    for (const k of Object.keys(out)) out[k] = full[k] - before[k];
    return { before, full, after: out };
  }

  // Per-play forensic trace: how each play was classified and exactly which
  // stats it credited to whom. creditPlay has no cross-play state, so running
  // each play into a fresh accumulator yields its isolated contribution.
  // (No ctx: summary-format lines are never marked as dupes in a trace.)
  function tracePlays(summary) {
    const entries = buildMatcher(summary);
    return allPlays(summary).map((play) => {
      const acc = {};
      const branch = creditPlay(play, entries, acc) || 'other';
      return { play, elapsed: playElapsedSec(play), key: nameKey(play.text), branch, credits: acc };
    });
  }

  function diagnostics(summary) {
    const plays = allPlays(summary);
    const clocked = plays.filter((p) => playElapsedSec(p) != null);
    return {
      totalPlays: plays.length,
      clockedPlays: clocked.length,
      clockedPct: plays.length ? Math.round((clocked.length / plays.length) * 100) : 0,
      periods: [...new Set(clocked.map((p) => p.period?.number))].sort(),
      samplePlay: clocked[Math.floor(clocked.length / 2)] || null,
    };
  }

  window.PBP = { allPlays, playElapsedSec, buildMatcher, reconstructAt, statsAfterBoundary, diagnostics, tracePlays, nameKey, zero };
})();
