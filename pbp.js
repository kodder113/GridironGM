/* ==================================================================
   PBP — ESPN play-by-play reconstruction library (Tier 2 of the
   boundary-based Live Coaching scoring model).

   Purpose: given an ESPN `summary?event=` payload, reconstruct a
   player's cumulative fantasy-relevant stat line at an arbitrary
   normalized game-clock boundary (0..1 of the scheduled 60 minutes).

   Attribution rule: a play belongs to the segment in which it was
   SNAPPED — production from a play snapped at or after the boundary
   counts as post-boundary. Plays nullified by penalty ("No Play") are
   excluded. Two-point conversions are ignored (consistent with the
   scoring engine). Overtime elapsed time runs past 1.0 (3600s + OT).

   Exposed as window.PBP. No dependencies.
   ================================================================== */
(function () {
  'use strict';

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
      for (const pl of d.plays || []) out.push(pl);
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
    const entries = []; // {id, name, patterns}
    for (const teamBlock of (summary.boxscore && summary.boxscore.players) || []) {
      for (const cat of teamBlock.statistics || []) {
        for (const a of cat.athletes || []) {
          if (!a.athlete) continue;
          const id = String(a.athlete.id);
          if (entries.some((e) => e.id === id)) continue;
          entries.push({ id, name: a.athlete.displayName, patterns: patternsFor(a.athlete.displayName) });
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

  // find the athlete whose pattern appears at `text.slice(idx)` boundaries
  function matchAt(entries, textKey, idx) {
    let best = null;
    for (const e of entries) {
      for (const p of e.patterns) {
        if (textKey.startsWith(p, idx)) {
          if (!best || p.length > best.len) best = { id: e.id, len: p.length };
        }
      }
    }
    return best;
  }
  function firstMatch(entries, textKey, fromIdx) {
    for (let i = fromIdx; i < textKey.length; i++) {
      const m = matchAt(entries, textKey, i);
      if (m) return { ...m, idx: i };
    }
    return null;
  }

  // ---- per-play stat extraction (fantasy-relevant only) ----
  const zero = () => ({
    passYds: 0, passTD: 0, passInt: 0, passComp: 0, passAtt: 0,
    rushYds: 0, rushTD: 0, rushAtt: 0,
    rec: 0, recYds: 0, recTD: 0,
    fumLost: 0, fgMade: 0, fgAtt: 0, fgBonus: 0, xpMade: 0, xpAtt: 0,
  });

  // Returns a branch label describing how the play was classified — used by
  // tracePlays() for diagnostics; reconstructAt() ignores it.
  function creditPlay(play, entries, acc) {
    const text = String(play.text || '');
    if (/no play/i.test(text)) return 'no-play';            // nullified by penalty
    if (/two-point|two point/i.test(text)) return 'two-point'; // 2pt ignored by design
    // `key` (digits stripped) is only for NAME matching; every numeric or
    // phrase predicate parses `low`, which keeps digits.
    const key = nameKey(text);
    const low = text.toLowerCase();
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

    // field goals / extra points
    if (/(?:yard|yd) field goal/.test(low)) {
      const kicker = firstMatch(entries, key, 0);
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
    if (/extra point/.test(low)) {
      const kicker = firstMatch(entries, key, 0);
      if (!kicker) return 'xp-nokicker';
      const k = get(kicker.id);
      k.xpAtt++;
      if (/is good/.test(low)) k.xpMade++;
      return 'xp';
    }
    if (/kicks|punts|kickoff|punt/.test(low) && !/pass|rush|left|right|middle|scrambles/.test(low)) return 'kick';

    // passes
    if (/ pass /.test(low) || /^(\(.*?\)\s*)?\S+.*? pass(ed)? /.test(low)) {
      const passer = firstMatch(entries, key, 0);
      if (!passer) return 'pass-no-passer';
      const p = get(passer.id);
      if (/intercepted/.test(low)) { p.passAtt++; p.passInt++; return 'pass-int'; }
      if (/incomplete/.test(low)) { p.passAtt++; return 'pass-incomplete'; }
      const toIdx = key.indexOf(' to ');
      const receiver = toIdx >= 0 ? firstMatch(entries, key, toIdx + 4) : null;
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
        if (td) r.recTD++;
      }
      fumbleCheck(low, key, entries, acc, receiver ? receiver.id : passer.id);
      return receiver ? 'pass' : 'pass-no-receiver';
    }

    // sacks: no fantasy-relevant offense stats in our model
    if (/sacked/.test(low)) { fumbleCheck(low, key, entries, acc, null); return 'sack'; }

    // rushes (incl. scrambles and kneels)
    if (/(left|right|middle|end|guard|tackle|scrambles|kneels|up the middle)/.test(low)) {
      const rusher = firstMatch(entries, key, 0);
      const yds = ydsMatch();
      if (!rusher || yds == null) return !rusher ? 'rush-no-rusher' : 'rush-no-yds';
      const r = get(rusher.id);
      r.rushAtt++; r.rushYds += yds;
      if (td) r.rushTD++;
      fumbleCheck(low, key, entries, acc, rusher.id);
      return 'rush';
    }
    return 'other';
  }

  function fumbleCheck(low, key, entries, acc, carrierId) {
    if (!/fumbles/.test(low)) return;
    // lost only if recovered by the other team — approximate: 'recovered by
    // <TEAM-ABBR>-<player>' where the recovering pattern includes a dash abbr
    const lost = /recovered by [a-z]{2,4}-/.test(low) || /touchback/.test(low);
    if (!lost) return;
    const who = carrierId ? { id: carrierId } : firstMatch(entries, key, 0);
    if (who) (acc[who.id] ||= zero()).fumLost++;
  }

  // ---- public API ----
  // cumulative fantasy stat lines for every box-score athlete, counting
  // only plays snapped STRICTLY BEFORE boundary (boundary in [0, 1+], 1 = 60:00)
  function reconstructAt(summary, boundary) {
    const entries = buildMatcher(summary);
    const acc = {};
    for (const play of allPlays(summary)) {
      const el = playElapsedSec(play);
      if (el == null) continue;
      if (el / 3600 >= boundary) continue;
      creditPlay(play, entries, acc);
    }
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
