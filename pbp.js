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

  // GSIS-style team abbreviations (used inside play text) vs ESPN's
  const ABBR_FIX = { BLT: 'BAL', ARZ: 'ARI', CLV: 'CLE', HST: 'HOU' };
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
  // "Patrick Mahomes" -> ["p.mahomes", "patrick mahomes", "mahomes"]
  function patternsFor(fullName) {
    const clean = String(fullName || '').replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '').trim();
    const parts = clean.split(/\s+/);
    if (parts.length < 2) return [nameKey(clean)];
    const first = parts[0];
    const last = parts.slice(1).join(' ');
    return [
      nameKey(`${first[0]}.${last}`),
      nameKey(clean),
      nameKey(last),
    ];
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
    // last-name-only patterns are ambiguous when two players share a surname
    const lastCounts = {};
    for (const e of entries) {
      const last = e.patterns[2];
      lastCounts[last] = (lastCounts[last] || 0) + 1;
    }
    for (const e of entries) {
      if (lastCounts[e.patterns[2]] > 1) e.patterns = e.patterns.slice(0, 2);
    }
    return entries;
  }

  // find the athlete whose pattern appears at `textKey.slice(idx)`; ties on
  // pattern length (e.g. two players sharing "t.etienne") break toward the
  // team on offense for the play's drive
  function matchAt(entries, textKey, idx, offense) {
    const cands = [];
    for (const e of entries) {
      for (const p of e.patterns) {
        if (textKey.startsWith(p, idx)) cands.push({ e, len: p.length });
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.len - a.len
      || (offense ? (b.e.team === offense) - (a.e.team === offense) : 0));
    return { id: cands[0].e.id, len: cands[0].len };
  }
  function firstMatch(entries, textKey, fromIdx, offense) {
    for (let i = fromIdx; i < textKey.length; i++) {
      const m = matchAt(entries, textKey, i, offense);
      if (m) return { ...m, idx: i };
    }
    return null;
  }
  // the athlete whose pattern ENDS the given prefix (name immediately before
  // a marker like "extra point" / "yard field goal") — avoids grabbing an
  // unrelated name earlier in the text (penalties, tacklers)
  function matchEnding(entries, pre) {
    const s = String(pre || '').replace(/[\s.]+$/, '');
    let best = null;
    for (const e of entries) {
      for (const p of e.patterns) {
        if (!s.endsWith(p)) continue;
        const i = s.length - p.length;
        if (i > 0 && s[i - 1] !== ' ' && s[i - 1] !== '.') continue;
        if (!best || p.length > best.len) best = { id: e.id, len: p.length };
      }
    }
    return best;
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
  // scoring-summary-format line ("<Scorer> 13 Yd pass from <Passer>")
  const isSummaryLine = (pl) => /\d+\s*yd (?:pass from|run\b|rush\b)/i.test(String(pl.text || ''));

  // Returns a branch label describing how the play was classified — used by
  // tracePlays() for diagnostics; reconstructAt() ignores it.
  // ctx (optional) carries the TD dedupe set within one reconstruction pass.
  function creditPlay(play, entries, acc, ctx) {
    return creditText(String(play.text || ''), play, entries, acc, ctx);
  }

  function creditText(text, play, entries, acc, ctx) {
    const offense = play._offense || null;
    const low = text.toLowerCase();

    // a two-point attempt never counts, but the TD before it in the same
    // text does — truncate and recurse on the part before the marker
    const tpIdx = (() => { const i = low.indexOf('two-point'); return i >= 0 ? i : low.indexOf('two point'); })();
    if (tpIdx >= 0) {
      const base = text.slice(0, tpIdx).replace(/\(\s*$/, '');
      if (!base.trim()) return 'two-point';
      return (creditText(base, play, entries, acc, ctx) || 'two-point') + '~2pt-dropped';
    }
    if (/no play/i.test(low)) return 'no-play';            // nullified by penalty
    if (/spiked the ball/.test(low)) return 'spike';

    // `key` (digits stripped) is only for NAME matching; every numeric or
    // phrase predicate parses `low`, which keeps digits.
    const key = nameKey(text);
    const td = /touchdown/.test(low);
    const get = (id) => (acc[id] ||= zero());
    const ydsMatch = () => {
      let m = low.match(/for (-?\d+) (?:yards?|yds?)\b/);
      if (m) return Number(m[1]);
      m = low.match(/for a loss of (\d+) (?:yards?|yds?)\b/);
      if (m) return -Number(m[1]);
      if (/for no gain/.test(low)) return 0;
      return null;
    };

    // TD play with the extra point merged into the same text: split at the
    // end of the TOUCHDOWN sentence, credit both halves
    const xpIdx = low.indexOf(' extra point');
    if (td && xpIdx > 0) {
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
      summaryKick(low, entries, acc);
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
      summaryKick(low, entries, acc);
      return 'score-summary-rush';
    }

    // field goals / extra points — the kicker is the name immediately
    // before the marker (firstMatch could grab a tackler or penalized
    // player named earlier in the text)
    const fgAt = key.search(/ (?:yard|yd) field goal/);
    if (fgAt >= 0) {
      const kicker = matchEnding(entries, key.slice(0, fgAt)) || firstMatch(entries, key, 0, offense);
      const dist = (low.match(/(\d+)\s*(?:yard|yd) field goal/) || [])[1];
      if (!kicker) return 'fg-nokicker';
      const k = get(kicker.id);
      k.fgAtt++;
      if (/is good/.test(low)) {
        k.fgMade++;
        const d = Number(dist) || 0;
        if (d >= 50) k.fgBonus += 2; else if (d >= 40) k.fgBonus += 1;
      }
      return 'fg';
    }
    if (xpIdx >= 0) {
      const kicker = (xpIdx > 0 && matchEnding(entries, key.slice(0, key.indexOf(' extra point'))))
        || firstMatch(entries, key, 0, offense);
      if (!kicker) return 'xp-nokicker';
      const k = get(kicker.id);
      k.xpAtt++;
      if (/is good/.test(low)) k.xpMade++;
      return 'xp';
    }
    if (/kicks|punts|kickoff|punt/.test(low) && !/pass|rush|left|right|middle|scrambles/.test(low)) return 'kick';

    // passes
    if (/ pass /.test(low) || /^(\(.*?\)\s*)?\S+.*? pass(ed)? /.test(low)) {
      const passer = firstMatch(entries, key, 0, offense);
      if (!passer) return 'pass-no-passer';
      const p = get(passer.id);
      if (/intercepted/.test(low)) { p.passAtt++; p.passInt++; return 'pass-int'; }
      if (/incomplete/.test(low)) { p.passAtt++; return 'pass-incomplete'; }
      const toIdx = key.indexOf(' to ');
      const receiver = toIdx >= 0 ? firstMatch(entries, key, toIdx + 4, offense) : null;
      const yds = ydsMatch();
      if (yds == null) { // completed but yardage not parseable (rare)
        p.passAtt++; p.passComp++;
        return 'pass-no-yds';
      }
      p.passAtt++; p.passComp++; p.passYds += yds;
      if (td) p.passTD++;
      if (receiver) {
        const r = get(receiver.id);
        r.rec++; r.recYds += yds;
        if (td) { r.recTD++; if (ctx) ctx.td.add(tdKey(play, receiver.id)); }
      }
      fumbleCheck(low, key, entries, acc, receiver ? receiver.id : passer.id, offense);
      return receiver ? 'pass' : 'pass-no-receiver';
    }

    // sacks: no fantasy-relevant offense stats in our model
    if (/sacked/.test(low)) { fumbleCheck(low, key, entries, acc, null, offense); return 'sack'; }

    // rushes (incl. scrambles and kneels)
    if (/(left|right|middle|end|guard|tackle|scrambles|kneels|up the middle)/.test(low)) {
      const rusher = firstMatch(entries, key, 0, offense);
      const yds = ydsMatch();
      if (!rusher || yds == null) return !rusher ? 'rush-no-rusher' : 'rush-no-yds';
      const r = get(rusher.id);
      r.rushAtt++; r.rushYds += yds;
      if (td) { r.rushTD++; if (ctx) ctx.td.add(tdKey(play, rusher.id)); }
      fumbleCheck(low, key, entries, acc, rusher.id, offense);
      return 'rush';
    }
    // aborted snaps etc.: a fumble can occur on an otherwise unclassified play
    if (/fumbles/.test(low)) { fumbleCheck(low, key, entries, acc, null, offense); return 'fumble'; }
    return 'other';
  }

  // "(<Kicker> Kick)" tail on scoring-summary lines
  function summaryKick(low, entries, acc) {
    const m = low.match(/\(([a-z\-'. ]+?) kick\)/);
    if (!m) return;
    const kicker = matchEnding(entries, nameKey(m[1]));
    if (kicker) {
      const k = (acc[kicker.id] ||= zero());
      k.xpAtt++; k.xpMade++;
    }
  }

  function fumbleCheck(low, key, entries, acc, carrierId, offense) {
    if (!/fumbles/.test(low)) return;
    const found = carrierId ? { id: carrierId } : firstMatch(entries, key, 0, offense);
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
