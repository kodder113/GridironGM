/* ==================================================================
   COACH SIMULATOR (developer-only) — simulator.html
   Feeds constructed matchup states through the EXACT production Coach
   Engine: the real buildSituation(), detectSignals(), COACHES policies,
   runCoachEngine() persistence + dedupe, speakRec() voice, and the real
   accept flow (openLiveSub). Isolation comes from sim/supamock.js: all
   reads/writes hit in-memory tables and window.fetch is disabled, so
   nothing can touch production data.
   ================================================================== */

const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };
// exact points via receiving yards under default scoring (0.1/yd)
const mkStats = (pts) => ({ recYds: Math.round(pts * 10) });

const SIM_DEFAULTS = {
  starterPos: 'RB', starterPosRank: 20, starterPts: 1.2,
  quarter: 3, clock: '4:10',
  benchState: 'pre',      // pre | in | post | bye | none
  benchPosRank: 10, benchPts: 0, benchKickMins: 22,
  swapUsed: false,
  qbState: 'pre', qbPts: 5,       // my QB1: pre (yet to play) or post (done)
  wrPts: 14,                       // my WR1 — always final
  tePosRank: 8, teState: 'pre', teEmpty: false, teBye: false, teFa: false,
  benchTE: false, benchTePosRank: 2,
  oppBanked: 20, oppSecond: 8, oppSecondState: 'post', oppLivePts: 6.2,
};

function stateTeam(state, side) {
  // teams are mapped onto the four simulated NFL games
  if (state === 'in') return side === 'b' ? 'GB' : 'DET';
  if (state === 'pre') return side === 'b' ? 'BUF' : 'KC';
  if (state === 'post') return side === 'b' ? 'TEN' : 'MIA';
  return 'ARI'; // bye — no game this week
}

function makeWorld(o = {}) {
  const opt = { ...SIM_DEFAULTS, ...o };
  // wipe any real-app localStorage caches that fetchWeekEvents might read
  for (const k of Object.keys(localStorage)) {
    if (/^ff_(ev|done|byes)_/.test(k)) localStorage.removeItem(k);
  }
  me = { id: 'u1', name: 'Oscar Rodriguez' };
  ownersCache = [{ id: 'u1', name: 'Oscar', username: 'oscar' },
                 { id: 'u2', name: 'Rival', username: 'rival' }];
  league = { id: 'L1', status: 'active', num_teams: 2, num_divisions: 1, playoff_teams: 2,
    commissioner_id: 'u1', roster: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 0, K: 0, DST: 0, BN: 3 } };
  teams = [{ id: 't1', owner_id: 'u1', name: 'Sim Squad', coach: 'grit' },
           { id: 't2', owner_id: 'u2', name: 'Rival Team', coach: 'grit' }];
  matchupsAll = [{ week: 1, home_team_id: 't1', away_team_id: 't2' }];
  currentNflWeek = 1; selectedWeek = 1; activeTab = 'matchup';
  lastAutoOverall = 0;

  const events = [
    { id: 'g1', date: new Date(Date.now() - 2 * 3600e3).toISOString(), state: 'in', completed: false,
      detail: `${opt.clock} - ${ORD[opt.quarter]}`, home: 'DET', away: 'CHI', homeScore: 17, awayScore: 14 },
    { id: 'g2', date: new Date(Date.now() + opt.benchKickMins * 60e3).toISOString(), state: 'pre',
      completed: false, detail: '', home: 'KC', away: 'BUF', homeScore: 0, awayScore: 0 },
    { id: 'g3', date: new Date(Date.now() - 5 * 3600e3).toISOString(), state: 'post', completed: true,
      detail: 'Final', home: 'MIA', away: 'TEN', homeScore: 24, awayScore: 20 },
    { id: 'g4', date: new Date(Date.now() + 3 * 3600e3).toISOString(), state: 'pre', completed: false,
      detail: '', home: 'LV', away: 'SEA', homeScore: 0, awayScore: 0 },
    { id: 'g5', date: new Date(Date.now() - 20 * 60e3).toISOString(), state: 'in', completed: false,
      detail: '12:00 - 1st', home: 'GB', away: 'MIN', homeScore: 3, awayScore: 0 },
  ];
  eventsByWeek = { 1: events };
  localStorage.setItem(`ff_ev_${SEASON}_1`, JSON.stringify({ ts: Date.now(), events }));
  statsSyncAt[1] = Date.now(); // throttle any background sync

  const P = [];
  const addP = (id, name, pos, team, pos_rank) => {
    P.push({ id, name, position: pos, team, pos_rank, rank: pos_rank });
    return id;
  };
  addP('ST', 'Focus Starter', opt.starterPos, 'DET', opt.starterPosRank);
  addP('MYQB', 'My QB', 'QB', stateTeam(opt.qbState), 5);
  addP('MYWR', 'My WR1', 'WR', 'MIA', 4);
  if (!opt.teEmpty) {
    addP('MYTE', 'My TE', 'TE', opt.teFa ? null : opt.teBye ? 'ARI' : stateTeam(opt.teState), opt.tePosRank);
  }
  if (opt.benchState !== 'none') {
    addP('BN1', 'Bench Option', opt.starterPos, stateTeam(opt.benchState, 'b'), opt.benchPosRank);
  }
  if (opt.benchTE) addP('BNTE', 'Bench TE', 'TE', 'LV', opt.benchTePosRank);
  addP('OQ', 'Opp QB', 'QB', 'MIA', 6);
  addP('OR', 'Opp RB', 'RB', opt.oppSecondState === 'pre' ? 'BUF' : 'TEN', 5);
  addP('OW', 'Opp WR', 'WR', 'CHI', 10);
  nflPlayers = new Map(P.map((p) => [p.id, p]));

  const statRows = [
    { pid: 'ST', pts: opt.starterPts },
    { pid: 'MYWR', pts: opt.wrPts },
    ...(opt.qbState === 'post' ? [{ pid: 'MYQB', pts: opt.qbPts }] : []),
    ...(opt.benchState !== 'none' && opt.benchPts ? [{ pid: 'BN1', pts: opt.benchPts }] : []),
    { pid: 'OQ', pts: opt.oppBanked },
    ...(opt.oppSecondState === 'post' ? [{ pid: 'OR', pts: opt.oppSecond }] : []),
    { pid: 'OW', pts: opt.oppLivePts },
  ];
  statsByWeek = { 1: new Map(statRows.map((r) => [r.pid, {
    season: SEASON, week: 1, nfl_player_id: r.pid, stats: mkStats(r.pts),
    points: r.pts, game_status: 'in_progress',
  }])) };
  window.__simTables.ff_player_week_stats = statRows.map((r) => ({
    season: SEASON, week: 1, nfl_player_id: r.pid, stats: mkStats(r.pts), points: r.pts,
  }));

  lineupsByWeek = { 1: [
    { team_id: 't1', week: 1, slot: 'QB1', nfl_player_id: 'MYQB' },
    { team_id: 't1', week: 1, slot: 'RB1', nfl_player_id: opt.starterPos === 'RB' ? 'ST' : 'ORPHAN' },
    { team_id: 't1', week: 1, slot: 'WR1', nfl_player_id: opt.starterPos === 'WR' ? 'ST' : 'MYWR' },
    ...(opt.teEmpty ? [] : [{ team_id: 't1', week: 1, slot: 'TE1', nfl_player_id: 'MYTE' }]),
    { team_id: 't2', week: 1, slot: 'QB1', nfl_player_id: 'OQ' },
    { team_id: 't2', week: 1, slot: 'RB1', nfl_player_id: 'OR' },
    { team_id: 't2', week: 1, slot: 'WR1', nfl_player_id: 'OW' },
  ].filter((l) => l.nfl_player_id !== 'ORPHAN' || opt.starterPos === 'RB') };
  if (opt.starterPos !== 'RB' && opt.starterPos !== 'WR') {
    // focus starter in its own slot (e.g. TE1/QB1 focus scenarios)
    lineupsByWeek[1] = lineupsByWeek[1].filter((l) => !(l.team_id === 't1' && l.slot === opt.starterPos + '1'));
    lineupsByWeek[1].push({ team_id: 't1', week: 1, slot: opt.starterPos + '1', nfl_player_id: 'ST' });
  }
  if (opt.starterPos === 'RB') {
    lineupsByWeek[1] = lineupsByWeek[1].map((l) =>
      l.team_id === 't1' && l.slot === 'RB1' ? { ...l, nfl_player_id: 'ST' } : l);
  }

  rosters = P.filter((p) => !['OQ', 'OR', 'OW'].includes(p.id))
    .map((p, i) => ({ id: 'r' + i, league_id: 'L1', team_id: 't1', nfl_player_id: p.id }))
    .concat(['OQ', 'OR', 'OW'].map((pid, i) => ({ id: 'o' + i, league_id: 'L1', team_id: 't2', nfl_player_id: pid })));

  swapsAll = opt.swapUsed ? [{
    id: 'sw1', league_id: 'L1', team_id: 't1', week: 1, slot: opt.starterPos + '1',
    out_player_id: 'ST', in_player_id: opt.benchState !== 'none' ? 'BN1' : 'MYWR',
    out_points_at_swap: opt.starterPts, in_points_at_swap: 0,
    boundary: 0.5, in_elapsed_at_swap: 0.5,
    out_stats_at_swap: mkStats(opt.starterPts), in_stats_at_boundary: mkStats(0),
    boundary_status: 'observed',
    swapped_at: new Date().toISOString(),
  }] : [];

  coachRecs = [];
  window.__simTables.ff_coach_recs = [];
  window.__simWrites.length = 0;
  return opt;
}

// ---- run one world through BOTH coaches via the real engine ----
async function simRunBoth(opts) {
  const results = {};
  for (const key of ['grit', 'analyst']) {
    makeWorld(opts);
    teams[0].coach = key;
    await runCoachEngine('sim');
    const sit = buildSituation(1);
    results[key] = {
      sit,
      recs: [...(window.__simTables.ff_coach_recs || [])],
      dockHtml: document.getElementById('coach-dock')?.innerHTML || '',
      calm: (PHRASES[key].calm[sit.band] || PHRASES[key].calm.none)(sit),
    };
  }
  return results;
}

// ---- predefined edge cases with expected verdicts per coach ----
const SCENARIOS = [
  // Boundary model: a sub only earns the slot's REMAINING normalized time on
  // his own clock, so viable subs happen earlier and need a real talent gap.
  { key: 'classic-sub', name: 'Underperforming RB (mid-Q2), elite bench kicks off soon',
    opts: { quarter: 2, clock: '2:00', benchPosRank: 4 }, expect: { grit: ['SUB'], analyst: ['SUB'] } },
  { key: 'bench-live-sub', name: 'Underperformer, elite bench option already LIVE',
    opts: { quarter: 2, clock: '2:00', benchPosRank: 4, benchState: 'in', benchPts: 8 },
    expect: { grit: ['SUB'], analyst: ['SUB'] } },
  { key: 'marginal-divergence', name: 'Marginal boundary-priced gain — Grit acts, Analyst holds',
    opts: { quarter: 3, clock: '6:00', benchPosRank: 4, oppBanked: 13, oppSecond: 0 },
    expect: { grit: ['SUB'], analyst: ['HOLD'] } },
  { key: 'late-sub-worthless', name: 'Q3 fade, fresh bench — boundary makes the sub worthless',
    opts: {}, expect: { grit: ['HOLD'], analyst: ['HOLD'] } },
  { key: 'bench-final', name: 'Bench already played (final) — sub illegal',
    opts: { benchState: 'post' }, expect: { grit: ['HOLD'], analyst: ['HOLD'] } },
  { key: 'no-bench', name: 'No replacement on the bench',
    opts: { benchState: 'none' }, expect: { grit: ['HOLD'], analyst: ['HOLD'] } },
  { key: 'slot-spent', name: 'Live sub already used for this slot',
    opts: { swapUsed: true, benchState: 'in', benchPts: 4 }, expect: { grit: ['HOLD'], analyst: ['HOLD'] } },
  { key: 'q1-too-early', name: 'Q1, 10:00 — too early to judge anyone',
    opts: { quarter: 1, clock: '10:00' }, expect: { grit: ['HOLD'], analyst: ['HOLD'] } },
  { key: 'long-shot-silent', name: 'Blown out, nothing left — coach stays honest',
    opts: { qbState: 'post', qbPts: 4, teState: 'post', oppBanked: 42, benchState: 'none' },
    expect: { grit: [], analyst: [] } },
  { key: 'protect-lead', name: 'Big lead, starter fine — protect it',
    opts: { starterPts: 9, wrPts: 40 }, expect: { grit: ['PROTECT'], analyst: ['PROTECT'] } },
  { key: 'te-bye-fix', name: 'TE on bye (the classic obvious fix)',
    opts: { starterPts: 9, teBye: true, benchTE: true, oppBanked: 30 },
    expect: { grit: ['FIX'], analyst: ['FIX'] } },
  { key: 'empty-slot-fix', name: 'Empty TE slot with a bench TE available',
    opts: { starterPts: 9, teEmpty: true, benchTE: true, oppBanked: 30 },
    expect: { grit: ['FIX'], analyst: ['FIX'] } },
  { key: 'fa-starter-fix', name: 'Starter is a team-less free agent',
    opts: { starterPts: 9, teFa: true, benchTE: true, oppBanked: 30 },
    expect: { grit: ['FIX'], analyst: ['FIX'] } },
  { key: 'start-better-bench', name: 'Pre-kickoff: bench TE clearly better',
    opts: { starterPts: 9, tePosRank: 20, benchTE: true, benchTePosRank: 2, oppBanked: 14, oppSecond: 0 },
    expect: { grit: ['START'], analyst: ['START'] } },
];

// A win probability must never leak as a number — only bands. Game-CLOCK
// percentages ("from his own 47% mark", "% boundary", "% of its game
// clock") are legitimate boundary-model language, not probabilities.
function probLeak(msg) {
  const scrubbed = String(msg || '')
    .replace(/\d+%\s*(mark|boundary|of (a|its|his|the)\b)/g, '');
  return /%|\b0\.\d{2,}\b/.test(scrubbed);
}

// ---- invariants: run against every scenario result ----
function checkInvariants(name, coachKey, res, asserts) {
  const A = (label, ok, detail) =>
    asserts.push({ scen: name, coach: coachKey, label, ok: !!ok, detail: detail || '' });
  for (const r of res.recs) {
    if (r.rec_type === 'SUB') {
      teams[0].coach = coachKey;
      const legal = liveSubCandidates(r.slot).some((p) => p.id === r.in_player_id);
      A('SUB is a legal substitution', legal, `${r.slot} → ${r.in_player_id}`);
      const inP = nflPlayers.get(r.in_player_id);
      const ev = inP && inP.team ? teamEvent(inP.team, 1) : null;
      A('sub-in game is not final', ev && !ev.completed, r.in_player_id);
      A('slot has no spent live sub', !swapsAll.some((s) => s.team_id === 't1' && s.week === 1 && s.slot === r.slot));
    }
    A('message has no raw win-probability', r.message && !probLeak(r.message), r.message);
    A('message is non-empty', !!r.message);
  }
  A('calm line has no raw win-probability', !probLeak(res.calm), res.calm);
  const bandStrings = ['Strong Favorite', 'Favored', 'Toss-Up', 'Underdog', 'Long Shot'];
  if (res.sit.band) A('band is a named band, not a number', bandStrings.includes(res.sit.band), res.sit.band);
}

async function simRunAssertions() {
  const asserts = [];
  for (const sc of SCENARIOS) {
    const res = await simRunBoth(sc.opts);
    for (const key of ['grit', 'analyst']) {
      makeWorld(sc.opts); teams[0].coach = key; // fresh world for eligibility checks
      const types = res[key].recs.map((r) => r.rec_type).sort();
      const expected = [...sc.expect[key]].sort();
      asserts.push({ scen: sc.name, coach: key, label: `verdicts = [${expected.join(', ') || 'silent'}]`,
        ok: JSON.stringify(types) === JSON.stringify(expected), detail: `got [${types.join(', ')}]` });
      checkInvariants(sc.name, key, res[key], asserts);
    }
    // same verdict must never mean same sentence
    for (const t of ['SUB', 'HOLD', 'PROTECT', 'FIX', 'START']) {
      const g = res.grit.recs.find((r) => r.rec_type === t);
      const a = res.analyst.recs.find((r) => r.rec_type === t);
      if (g && a) {
        asserts.push({ scen: sc.name, coach: 'both', label: `${t}: distinct voice per coach`,
          ok: g.message !== a.message, detail: `grit="${g.message}" | analyst="${a.message}"` });
      }
    }
    // dedupe: a second engine pass must not duplicate recommendations
    makeWorld(sc.opts); teams[0].coach = 'grit';
    await runCoachEngine('sim');
    const n1 = window.__simTables.ff_coach_recs.length;
    await runCoachEngine('sim');
    const n2 = window.__simTables.ff_coach_recs.length;
    asserts.push({ scen: sc.name, coach: 'grit', label: 'dedupe: second pass adds nothing', ok: n1 === n2, detail: `${n1} → ${n2}` });
  }
  // accepting a SUB routes into the real modal and writes NOTHING to ff_swaps
  makeWorld({ quarter: 2, clock: '2:00', benchPosRank: 4 }); teams[0].coach = 'grit';
  await runCoachEngine('sim');
  const rec = (window.__simTables.ff_coach_recs || []).find((r) => r.rec_type === 'SUB');
  if (rec) {
    coachRecs = window.__simTables.ff_coach_recs;
    const swapWritesBefore = window.__simWrites.filter((w) => w.table === 'ff_swaps').length;
    await acceptCoachRec(rec.id);
    const swapWritesAfter = window.__simWrites.filter((w) => w.table === 'ff_swaps').length;
    asserts.push({ scen: 'accept flow', coach: 'grit', label: 'accepting writes nothing to ff_swaps',
      ok: swapWritesAfter === swapWritesBefore, detail: `${swapWritesBefore} → ${swapWritesAfter}` });
    const modal = document.getElementById('modal-box').innerHTML;
    asserts.push({ scen: 'accept flow', coach: 'grit', label: 'accept opens the real live-sub modal with the coach’s pick',
      ok: modal.includes('Live Coaching') && modal.includes('Coach’s pick') || modal.includes("Coach's pick"),
      detail: '' });
    closeModal();
    asserts.push({ scen: 'accept flow', coach: 'grit', label: 'decision persisted as accepted',
      ok: rec.decision === 'accepted', detail: rec.decision });
  } else {
    asserts.push({ scen: 'accept flow', coach: 'grit', label: 'SUB rec exists to accept', ok: false });
  }

  // ---- boundary-model invariants (exercise the PRODUCTION slotScore):
  // a lineup slot can never receive more than one normalized game's worth of
  // usable playing time, and no replacement receives retroactive points ----
  {
    const BA = (label, ok, detail) =>
      asserts.push({ scen: 'boundary model', coach: 'engine', label, ok: !!ok, detail: detail || '' });
    makeWorld({ benchState: 'in', benchPts: 8 });
    const B = gameBoundaryElapsed(teamEvent('DET', 1)); // focus starter's game
    BA('boundary is the starter\'s normalized elapsed (0<B<1 mid-game)', B > 0 && B < 1, `B=${B.toFixed(3)}`);
    const mkSwap = (over) => ({
      id: 'swB', league_id: 'L1', team_id: 't1', week: 1, slot: 'RB1',
      out_player_id: 'ST', in_player_id: 'BN1',
      out_points_at_swap: 1.2, in_points_at_swap: 8,
      out_stats_at_swap: mkStats(1.2), in_stats_at_boundary: mkStats(8),
      boundary: B, in_elapsed_at_swap: B, boundary_status: 'observed',
      swapped_at: new Date().toISOString(), ...over,
    });
    // 1) no retroactive points: everything the sub scored before the boundary is excluded
    swapsAll = [mkSwap()];
    const s1 = slotScore('t1', 1, 'RB1');
    BA('no retroactive points: sub\'s 8 pre-boundary pts excluded', Math.abs(s1.pts - 1.2) < 0.01, `slot=${s1.pts}`);
    // 2) post-boundary production counts in full
    const bn = statsByWeek[1].get('BN1');
    bn.stats = mkStats(12); bn.points = 12;
    const s2 = slotScore('t1', 1, 'RB1');
    BA('post-boundary production counts (+4)', Math.abs(s2.pts - 5.2) < 0.01, `slot=${s2.pts}`);
    // 3) pending boundary contributes ZERO until settled
    swapsAll = [mkSwap({ boundary_status: 'pending', in_stats_at_boundary: null })];
    const s3 = slotScore('t1', 1, 'RB1');
    BA('pending boundary: sub contributes zero', Math.abs(s3.pts - 1.2) < 0.01 && s3.pending === true, `slot=${s3.pts}`);
    // 4) effective boundary honors the SUB's own clock when he is ahead
    swapsAll = [mkSwap({ in_elapsed_at_swap: Math.min(1, B + 0.2) })];
    BA('effective boundary = max(B, sub elapsed)', Math.abs(swapEffBoundary(swapsAll[0]) - Math.min(1, B + 0.2)) < 1e-9,
      `E=${swapEffBoundary(swapsAll[0]).toFixed(3)}`);
    // 5) one normalized game per slot: consumed + usable never exceeds 1
    for (const inEl of [0, B, Math.min(1, B + 0.3), 1]) {
      const E = Math.max(B, inEl);
      BA(`slot time cap holds (sub elapsed ${inEl.toFixed(2)})`, B + (1 - E) <= 1 + 1e-9, `${B.toFixed(2)} + ${(1 - E).toFixed(2)}`);
    }
    // 6) OT or final consumes the slot completely
    BA('swap during OT consumes the slot at 100%',
      gameBoundaryElapsed({ state: 'in', completed: false, detail: 'OT 5:00' }) === 1, '');
    BA('final game consumes the slot at 100%',
      gameBoundaryElapsed({ state: 'post', completed: true, detail: 'Final' }) === 1, '');
    // 7) the Coach Engine prices a live sub by usable time on BOTH clocks
    makeWorld({ benchState: 'in', benchPts: 0 });
    const sit = buildSituation(1);
    const rb = sit.slots.find((s) => s.slot === 'RB1');
    if (rb && rb.best) {
      const benchFrac = gameFracRemaining(teamEvent('MIN', 1)); // bench lives on g5
      const expected = baselinePts(nflPlayers.get('BN1')) * Math.min(rb.frac, benchFrac);
      BA('SUB gain uses min(slot remaining, sub remaining)', Math.abs(rb.best.expRem - expected) < 0.01,
        `expRem=${rb.best.expRem.toFixed(2)} vs ${expected.toFixed(2)}`);
    } else {
      BA('SUB gain uses min(slot remaining, sub remaining)', false, 'no live alt found');
    }
    // 8) accepted-and-executed subs are scored with the same boundary math the
    // slot uses (never the old "everything he scores" formula)
    makeWorld({ swapUsed: true, benchState: 'in', benchPts: 8 });
    const spent = slotScore('t1', 1, 'RB1');
    BA('spent-slot score = out-at-swap + post-boundary only',
      Math.abs(spent.pts - (1.2 + 8)) < 0.01, `slot=${spent.pts} (out 1.2 + in 8 past his boundary line 0)`);
  }
  return asserts;
}

// ---- UI ----
let simActiveScenario = null;
function simRender() {
  document.getElementById('sim-root').innerHTML = `
    <div class="sim-bar"><h1>🧪 COACH SIMULATOR</h1>
      <span class="note">Developer only · runs the real Coach Engine against an in-memory backend · nothing here touches production data</span>
      <button class="btn-small gold" onclick="simAssert()">▶ Run all scenarios + assertions</button>
    </div>
    <div class="sim-grid">
      <div class="panel sim-controls">
        <h3>Scenarios</h3>
        <div id="sim-scenarios">${SCENARIOS.map((sc) => `
          <button class="scenario-btn ${simActiveScenario === sc.key ? 'active' : ''}"
            onclick="simScenario('${sc.key}')">${sc.name}</button>`).join('')}</div>
        <h3 style="margin-top:18px">Manual situation</h3>
        <div class="row2">
          <div><label>Starter pos</label><select id="m-pos"><option>RB</option><option>WR</option><option>TE</option><option>QB</option></select></div>
          <div><label>Starter pos-rank</label><input id="m-prank" type="number" value="20"/></div>
        </div>
        <div class="row2">
          <div><label>Starter pts</label><input id="m-pts" type="number" step="0.1" value="1.2"/></div>
          <div><label>Quarter</label><select id="m-q"><option>1</option><option>2</option><option selected>3</option><option>4</option></select></div>
        </div>
        <div class="row2">
          <div><label>Clock</label><input id="m-clock" value="4:10"/></div>
          <div><label>Bench state</label><select id="m-bstate"><option value="pre" selected>pre-game</option><option value="in">live</option><option value="post">final</option><option value="bye">bye</option><option value="none">no bench</option></select></div>
        </div>
        <div class="row2">
          <div><label>Bench pos-rank</label><input id="m-bprank" type="number" value="10"/></div>
          <div><label>Bench pts (if live)</label><input id="m-bpts" type="number" step="0.1" value="0"/></div>
        </div>
        <div class="row2">
          <div><label>Mins to bench kickoff</label><input id="m-kick" type="number" value="22"/></div>
          <div><label>Opp banked pts</label><input id="m-opp" type="number" step="0.1" value="20"/></div>
        </div>
        <div class="row2">
          <div><label>My WR1 pts (final)</label><input id="m-wr" type="number" step="0.1" value="14"/></div>
          <div><label>My QB game</label><select id="m-qb"><option value="pre" selected>yet to play</option><option value="post">finished</option></select></div>
        </div>
        <label style="margin-top:12px"><input type="checkbox" id="m-swap" style="width:auto;margin-right:6px"/>Live sub already used for this slot</label>
        <button class="btn-primary" style="margin-top:14px" onclick="simManual()">Run through both coaches</button>
      </div>
      <div>
        <div id="sim-results"><p class="empty-note">Pick a scenario or build a manual situation, then run it through Coach Grit and The Analyst side-by-side.</p></div>
        <div id="sim-asserts"></div>
      </div>
    </div>
    <div style="display:none"><div id="coach-dock"></div><div id="coach-strip"></div></div>`;
}

function simShowResults(name, results) {
  const col = (key) => {
    const c = COACHES[key];
    const r = results[key];
    const types = r.recs.map((x) => x.rec_type);
    return `<div class="coach-col">
      <h3>${c.icon} ${esc(c.name)}</h3>
      <div class="verdicts">${types.length
        ? types.map((t) => `<span class="verdict-chip">${t}</span>`).join('')
        : '<span class="verdict-chip silent">stays quiet</span>'}</div>
      ${r.recs.map((x) => `<div class="sim-say">"${esc(x.message)}"</div>`).join('')
        || `<div class="sim-say" style="border-color:var(--border);color:var(--muted)">"${esc(r.calm)}"</div>`}
      <div class="sim-meta">Margin ${r.sit.margin > 0 ? '+' : ''}${fmtPts(r.sit.margin)} · band: <b>${esc(r.sit.band || '—')}</b>
        · my exp ${fmtPts(r.sit.myExp)} vs opp ${fmtPts(r.sit.oppExp)}</div>
    </div>`;
  };
  document.getElementById('sim-results').innerHTML = `
    <h3 style="font-family:'Rajdhani';font-size:18px;margin-bottom:8px">${esc(name)}</h3>
    <div class="coach-cols">${col('grit')}${col('analyst')}</div>`;
}

async function simScenario(key) {
  simActiveScenario = key;
  const sc = SCENARIOS.find((x) => x.key === key);
  const results = await simRunBoth(sc.opts);
  simRender();
  simShowResults(sc.name, results);
}

async function simManual() {
  const opts = {
    starterPos: document.getElementById('m-pos').value,
    starterPosRank: +document.getElementById('m-prank').value || 20,
    starterPts: +document.getElementById('m-pts').value || 0,
    quarter: +document.getElementById('m-q').value || 3,
    clock: document.getElementById('m-clock').value || '4:10',
    benchState: document.getElementById('m-bstate').value,
    benchPosRank: +document.getElementById('m-bprank').value || 10,
    benchPts: +document.getElementById('m-bpts').value || 0,
    benchKickMins: +document.getElementById('m-kick').value || 22,
    oppBanked: +document.getElementById('m-opp').value || 20,
    wrPts: +document.getElementById('m-wr').value || 14,
    qbState: document.getElementById('m-qb').value,
    swapUsed: document.getElementById('m-swap').checked,
  };
  const manual = { ...opts };
  simActiveScenario = null;
  const results = await simRunBoth(manual);
  const saved = { ...manual };
  simRender();
  // restore form values after re-render
  document.getElementById('m-pos').value = saved.starterPos;
  document.getElementById('m-prank').value = saved.starterPosRank;
  document.getElementById('m-pts').value = saved.starterPts;
  document.getElementById('m-q').value = saved.quarter;
  document.getElementById('m-clock').value = saved.clock;
  document.getElementById('m-bstate').value = saved.benchState;
  document.getElementById('m-bprank').value = saved.benchPosRank;
  document.getElementById('m-bpts').value = saved.benchPts;
  document.getElementById('m-kick').value = saved.benchKickMins;
  document.getElementById('m-opp').value = saved.oppBanked;
  document.getElementById('m-wr').value = saved.wrPts;
  document.getElementById('m-qb').value = saved.qbState;
  document.getElementById('m-swap').checked = saved.swapUsed;
  simShowResults('Manual situation', results);
}

async function simAssert() {
  document.getElementById('sim-asserts').innerHTML = '<p class="empty-note">Running…</p>';
  const asserts = await simRunAssertions();
  const fails = asserts.filter((a) => !a.ok);
  window.__simAssertResults = { total: asserts.length, fails: fails.length };
  document.getElementById('sim-asserts').innerHTML = `
    <div class="sim-summary ${fails.length ? 'fail' : 'pass'}">
      ${fails.length ? `✗ ${fails.length} of ${asserts.length} assertions FAILED` : `✓ All ${asserts.length} assertions passed`}</div>
    <div class="assert-list panel">${asserts.map((a) => `
      <div class="assert-row"><span class="${a.ok ? 'ok' : 'fail'}">${a.ok ? '✓' : '✗'}</span>
        <span style="color:var(--muted);min-width:210px">${esc(a.scen)} · ${esc(a.coach)}</span>
        <span>${esc(a.label)}</span>
        ${!a.ok && a.detail ? `<span style="color:var(--red)">${esc(a.detail)}</span>` : ''}</div>`).join('')}</div>`;
}

simRender();
