/* Gridiron GM — Fantasy Football with Live Coaching */

const SUPABASE_URL = 'https://kixdpoizujvnwsyqgmqe.supabase.co';
const SUPABASE_KEY = 'sb_publishable_WjQnlIyAB4950hD7UivS8g_vr0b8JeU';
const SEASON = 2026;
const LAST_SEASON = SEASON - 1;
const NFL_WEEKS = 18;
const FANTASY_WEEKS = NFL_WEEKS - 1; // nobody plays their starters in Week 18
// ---- commissioner-configurable roster construction ----
const STARTER_POS = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'];
const DEFAULT_ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BN: 6 };
const leagueRoster = (l) => ({ ...DEFAULT_ROSTER, ...((l && l.roster) || {}) });
function leagueSlots(l) {
  const r = leagueRoster(l);
  const out = [];
  for (const pos of STARTER_POS) {
    for (let i = 1; i <= (Number(r[pos]) || 0); i++) out.push(pos + i);
  }
  return out;
}
const slotPosOf = (slot) => slot.replace(/\d+$/, '');
const slotEligible = (slot) => slotPosOf(slot) === 'FLEX' ? ['RB', 'WR', 'TE'] : [slotPosOf(slot)];
// "RB2" stays "RB2", but a position with a single starter shows as just "QB"
function slotLabel(slot, l) {
  const pos = slotPosOf(slot);
  return (Number(leagueRoster(l)[pos]) || 0) > 1 ? slot : pos;
}
const starterCount = (l) => STARTER_POS.reduce((s, p) => s + (Number(leagueRoster(l)[p]) || 0), 0);
const rosterSize = (l) => starterCount(l) + (Number(leagueRoster(l).BN) || 0);
const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DST: 5 };
const STATS_SYNC_MS = 60 * 1000;

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const TEAMS = {
  ARI: { city: 'Arizona', name: 'Cardinals', espn: 'ari', espnId: 22 },
  ATL: { city: 'Atlanta', name: 'Falcons', espn: 'atl', espnId: 1 },
  BAL: { city: 'Baltimore', name: 'Ravens', espn: 'bal', espnId: 33 },
  BUF: { city: 'Buffalo', name: 'Bills', espn: 'buf', espnId: 2 },
  CAR: { city: 'Carolina', name: 'Panthers', espn: 'car', espnId: 29 },
  CHI: { city: 'Chicago', name: 'Bears', espn: 'chi', espnId: 3 },
  CIN: { city: 'Cincinnati', name: 'Bengals', espn: 'cin', espnId: 4 },
  CLE: { city: 'Cleveland', name: 'Browns', espn: 'cle', espnId: 5 },
  DAL: { city: 'Dallas', name: 'Cowboys', espn: 'dal', espnId: 6 },
  DEN: { city: 'Denver', name: 'Broncos', espn: 'den', espnId: 7 },
  DET: { city: 'Detroit', name: 'Lions', espn: 'det', espnId: 8 },
  GB:  { city: 'Green Bay', name: 'Packers', espn: 'gb', espnId: 9 },
  HOU: { city: 'Houston', name: 'Texans', espn: 'hou', espnId: 34 },
  IND: { city: 'Indianapolis', name: 'Colts', espn: 'ind', espnId: 11 },
  JAX: { city: 'Jacksonville', name: 'Jaguars', espn: 'jax', espnId: 30 },
  KC:  { city: 'Kansas City', name: 'Chiefs', espn: 'kc', espnId: 12 },
  LA:  { city: 'Los Angeles', name: 'Rams', espn: 'lar', espnId: 14 },
  LAC: { city: 'Los Angeles', name: 'Chargers', espn: 'lac', espnId: 24 },
  LV:  { city: 'Las Vegas', name: 'Raiders', espn: 'lv', espnId: 13 },
  MIA: { city: 'Miami', name: 'Dolphins', espn: 'mia', espnId: 15 },
  MIN: { city: 'Minnesota', name: 'Vikings', espn: 'min', espnId: 16 },
  NE:  { city: 'New England', name: 'Patriots', espn: 'ne', espnId: 17 },
  NO:  { city: 'New Orleans', name: 'Saints', espn: 'no', espnId: 18 },
  NYG: { city: 'New York', name: 'Giants', espn: 'nyg', espnId: 19 },
  NYJ: { city: 'New York', name: 'Jets', espn: 'nyj', espnId: 20 },
  PHI: { city: 'Philadelphia', name: 'Eagles', espn: 'phi', espnId: 21 },
  PIT: { city: 'Pittsburgh', name: 'Steelers', espn: 'pit', espnId: 23 },
  SEA: { city: 'Seattle', name: 'Seahawks', espn: 'sea', espnId: 26 },
  SF:  { city: 'San Francisco', name: '49ers', espn: 'sf', espnId: 25 },
  TB:  { city: 'Tampa Bay', name: 'Buccaneers', espn: 'tb', espnId: 27 },
  TEN: { city: 'Tennessee', name: 'Titans', espn: 'ten', espnId: 10 },
  WAS: { city: 'Washington', name: 'Commanders', espn: 'wsh', espnId: 28 },
};
const ESPN_ABBR_FIX = { WSH: 'WAS', LAR: 'LA' };
const normAbbr = (a) => ESPN_ABBR_FIX[a] || a;
const teamFull = (abbr) => TEAMS[abbr] ? `${TEAMS[abbr].city} ${TEAMS[abbr].name}` : (abbr || 'FA');
const teamLogo = (abbr) => TEAMS[abbr]
  ? `https://a.espncdn.com/i/teamlogos/nfl/500/${TEAMS[abbr].espn}.png` : '';

// ---- commissioner-configurable scoring ----
// Counting stats are flat points per action. Yardage stats are {pts, per, whole}:
//   whole=false → every yard counts fractionally (1 pt per 10 yds: 7 yds = 0.7)
//   whole=true  → only COMPLETED chunks score (10 pts per 10 yds: 7 yds = 0)
const DEFAULT_SCORING = {
  passYds: { pts: 1, per: 25, whole: false }, passTD: 4, passInt: -2,
  rushYds: { pts: 1, per: 10, whole: false }, rushTD: 6,
  rec: 1, recYds: { pts: 1, per: 10, whole: false }, recTD: 6,
  fumLost: -2,
  xp: 1, fg: 3, fg40: 1, fg50: 2,
  dstSack: 1, dstInt: 2, dstFumRec: 2, dstTD: 6, dstSafety: 2,
};
const SCORING_DEFS = [
  { key: 'passYds', label: 'Passing yards', yardage: true },
  { key: 'passTD', label: 'Passing TD' },
  { key: 'passInt', label: 'Interception thrown' },
  { key: 'rushYds', label: 'Rushing yards', yardage: true },
  { key: 'rushTD', label: 'Rushing TD' },
  { key: 'rec', label: 'Reception' },
  { key: 'recYds', label: 'Receiving yards', yardage: true },
  { key: 'recTD', label: 'Receiving TD' },
  { key: 'fumLost', label: 'Fumble lost' },
  { key: 'fg', label: 'Field goal made' },
  { key: 'fg40', label: 'FG 40–49 yd bonus' },
  { key: 'fg50', label: 'FG 50+ yd bonus' },
  { key: 'xp', label: 'Extra point' },
  { key: 'dstSack', label: 'D/ST sack' },
  { key: 'dstInt', label: 'D/ST interception' },
  { key: 'dstFumRec', label: 'D/ST fumble recovery' },
  { key: 'dstTD', label: 'D/ST / return TD' },
  { key: 'dstSafety', label: 'D/ST safety' },
];
const SCORING_PRESETS = {
  ppr: { label: 'Standard — full PPR', patch: { rec: 1 } },
  half: { label: 'Half PPR', patch: { rec: 0.5 } },
  std: { label: 'Standard — non-PPR', patch: { rec: 0 } },
};
const leagueScoring = (l) => ({ ...DEFAULT_SCORING, ...((l && l.scoring) || {}) });
function yardPts(yds, rule) {
  if (rule == null) return 0;
  if (typeof rule === 'number') return yds * rule;
  const pts = Number(rule.pts) || 0;
  const per = Number(rule.per) || 1;
  return rule.whole ? Math.trunc(yds / per) * pts : yds * (pts / per);
}
function dstPaPoints(pa) {
  if (pa === 0) return 10;
  if (pa <= 6) return 7;
  if (pa <= 13) return 4;
  if (pa <= 20) return 1;
  if (pa <= 27) return 0;
  if (pa <= 34) return -1;
  return -4;
}

// ---------- state ----------
let me = null;
let myTeams = [];          // my ff_teams rows (all leagues)
let hubLeagues = [];       // leagues I'm in
let league = null;         // currently open league
let teams = [];            // teams in current league
let rosters = [];          // all roster rows in current league
let draftPicks = [];       // all draft picks in current league
let matchupsAll = [];      // all scheduled matchups in current league
let lineupsByWeek = {};    // week -> lineup rows (all teams in league)
let swapsAll = [];         // all live-coaching swaps in current league
let nflPlayers = new Map(); // id -> ff_nfl_players row
let statsByWeek = {};      // week -> Map(pid -> ff_player_week_stats row)
let eventsByWeek = {};     // week -> [espn events]
let currentNflWeek = 1;
let selectedWeek = 1;
let activeTab = 'team';
let draftPollTimer = null;
let liveTimer = null;
const statsSyncAt = {};    // week -> last sync ts

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtPts = (n) => (Math.round(n * 100) / 100).toFixed(1);
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) { console.warn(error); break; }
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ---------- init ----------
async function init() {
  populateTeamSelect();
  populateCreateLeagueSelects();
  const savedId = localStorage.getItem('ff_player_id');
  if (savedId) {
    const { data } = await sb.from('ff_players').select('*').eq('id', savedId).maybeSingle();
    if (data) me = data;
  }
  if (me) await enterHub();
  else showScreen('auth');
}

function showScreen(name) {
  ['auth', 'hub', 'league'].forEach((s) =>
    $(`${s}-screen`).classList.toggle('hidden', s !== name));
}

function populateTeamSelect() {
  const sel = $('signup-team');
  Object.keys(TEAMS)
    .sort((a, b) => teamFull(a).localeCompare(teamFull(b)))
    .forEach((abbr) => {
      const o = document.createElement('option');
      o.value = abbr;
      o.textContent = teamFull(abbr);
      sel.appendChild(o);
    });
}

function populateCreateLeagueSelects() {
  const sel = $('cl-teams');
  [4, 6, 8, 10, 12, 14, 16].forEach((n) => {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = `${n} teams`;
    if (n === 10) o.selected = true;
    sel.appendChild(o);
  });
  updateDivisionOptions();
  buildRosterEditor();
  buildScoringEditor();
}

// ---- roster & scoring editors (used by Create League and League Settings) ----
const ROSTER_EDIT = [
  { pos: 'QB', label: 'QB', max: 3 }, { pos: 'RB', label: 'RB', max: 5 },
  { pos: 'WR', label: 'WR', max: 5 }, { pos: 'TE', label: 'TE', max: 3 },
  { pos: 'FLEX', label: 'FLEX', max: 3 }, { pos: 'K', label: 'K', max: 2 },
  { pos: 'DST', label: 'DEF', max: 2 }, { pos: 'BN', label: 'Bench', max: 10 },
];
function rosterEditorHtml(prefix, values) {
  return ROSTER_EDIT.map(({ pos, label, max }) => `
    <div class="rc-item"><span class="rc-label ${pos === 'BN' ? '' : 'pos-' + pos}">${label}</span>
      <select id="${prefix}-r-${pos}" onchange="updateRosterSummary('${prefix}')">
        ${Array.from({ length: max + 1 }, (_, i) => `<option value="${i}" ${i === (Number(values[pos]) || 0) ? 'selected' : ''}>${i}</option>`).join('')}
      </select></div>`).join('');
}
function buildRosterEditor() {
  $('cl-roster').innerHTML = rosterEditorHtml('cl', DEFAULT_ROSTER);
  updateRosterSummary('cl');
}
function collectRosterForm(prefix) {
  const r = {};
  ROSTER_EDIT.forEach(({ pos }) => { r[pos] = parseInt($(`${prefix}-r-${pos}`).value, 10) || 0; });
  return r;
}
function updateRosterSummary(prefix) {
  const el = $(`${prefix}-roster-summary`);
  if (!el) return;
  const r = collectRosterForm(prefix);
  const starters = STARTER_POS.reduce((s, p) => s + r[p], 0);
  el.textContent =
    `${starters} starters + ${r.BN} bench = ${starters + r.BN} roster spots → a ${starters + r.BN}-round draft`;
}

// ---- scoring editor ----
function scoringEditorHtml(prefix, sc) {
  return SCORING_DEFS.map((d) => {
    const v = sc[d.key];
    if (d.yardage) {
      const rule = (typeof v === 'object' && v) || { pts: v, per: 1, whole: false };
      return `<div class="sc-row yardage">
        <span class="sc-label">${d.label}</span>
        <span class="sc-inputs">
          <input type="number" step="any" id="${prefix}-sc-${d.key}-pts" value="${Number(rule.pts) || 0}" onchange="markCustomScoring('${prefix}')"/> pts per
          <input type="number" step="1" min="1" id="${prefix}-sc-${d.key}-per" value="${Number(rule.per) || 1}" onchange="markCustomScoring('${prefix}')"/> yds
          <select id="${prefix}-sc-${d.key}-mode" onchange="markCustomScoring('${prefix}')">
            <option value="frac" ${rule.whole ? '' : 'selected'}>every yard counts (fractional)</option>
            <option value="whole" ${rule.whole ? 'selected' : ''}>whole chunks only — leftovers score 0</option>
          </select></span></div>`;
    }
    return `<div class="sc-row">
      <span class="sc-label">${d.label}</span>
      <span class="sc-inputs"><input type="number" step="any" id="${prefix}-sc-${d.key}" value="${Number(v) || 0}" onchange="markCustomScoring('${prefix}')"/> pts</span></div>`;
  }).join('') + `<p class="form-note">"Whole chunks only" is strict: at 10 pts per 10 yds, 7 yards is 0 points and 27 yards is 20 — only completed chunks count.
    D/ST points-allowed uses the standard tiers (0 pts allowed = 10 … 35+ = −4).</p>`;
}
function buildScoringEditor() {
  $('cl-scoring-grid').innerHTML = scoringEditorHtml('cl', DEFAULT_SCORING);
}
function markCustomScoring(prefix) { const el = $(`${prefix}-scoring-preset`); if (el) el.value = 'custom'; }
function applyScoringPreset(prefix) {
  const key = $(`${prefix}-scoring-preset`).value;
  const preset = SCORING_PRESETS[key];
  if (!preset) { const ed = $(`${prefix}-scoring-editor`); if (ed) ed.open = true; return; }
  const sc = { ...DEFAULT_SCORING, ...preset.patch };
  SCORING_DEFS.forEach((d) => {
    const v = sc[d.key];
    if (d.yardage) {
      $(`${prefix}-sc-${d.key}-pts`).value = v.pts;
      $(`${prefix}-sc-${d.key}-per`).value = v.per;
      $(`${prefix}-sc-${d.key}-mode`).value = v.whole ? 'whole' : 'frac';
    } else {
      $(`${prefix}-sc-${d.key}`).value = v;
    }
  });
  // re-select the preset (the inputs' onchange flipped it to custom)
  $(`${prefix}-scoring-preset`).value = key;
}
function collectScoringForm(prefix) {
  const sc = {};
  SCORING_DEFS.forEach((d) => {
    if (d.yardage) {
      sc[d.key] = {
        pts: parseFloat($(`${prefix}-sc-${d.key}-pts`).value) || 0,
        per: Math.max(1, parseInt($(`${prefix}-sc-${d.key}-per`).value, 10) || 1),
        whole: $(`${prefix}-sc-${d.key}-mode`).value === 'whole',
      };
    } else {
      sc[d.key] = parseFloat($(`${prefix}-sc-${d.key}`).value) || 0;
    }
  });
  return sc;
}
function detectPreset(sc) {
  for (const [key, preset] of Object.entries(SCORING_PRESETS)) {
    if (JSON.stringify({ ...DEFAULT_SCORING, ...preset.patch }) === JSON.stringify({ ...DEFAULT_SCORING, ...sc })) return key;
  }
  return 'custom';
}

// ---- commissioner: League Settings (rules editable like the big apps) ----
// Scoring & name: any time — scoring re-applies retroactively since every week
// is re-scored from raw stat lines. Structure (teams, divisions, playoffs,
// roster construction): only until the draft starts.
function openLeagueSettings() {
  if (!isCommish()) return;
  const preDraft = league.status === 'pre_draft';
  const sc = leagueScoring(league);
  const presetSel = `<select id="ls-scoring-preset" onchange="applyScoringPreset('ls')">
      ${Object.entries(SCORING_PRESETS).map(([k, p]) => `<option value="${k}" ${detectPreset(league.scoring || {}) === k ? 'selected' : ''}>${p.label}</option>`).join('')}
      <option value="custom" ${detectPreset(league.scoring || {}) === 'custom' ? 'selected' : ''}>Custom</option>
    </select>`;
  const structure = preDraft ? `
    <label class="ls-label">Number of Teams</label>
    <select id="ls-teams" onchange="updateDivisionOptions('ls')">
      ${[4, 6, 8, 10, 12, 14, 16].filter((n) => n >= teams.length).map((n) =>
        `<option value="${n}" ${n === league.num_teams ? 'selected' : ''}>${n} teams</option>`).join('')}
    </select>
    <label class="ls-label">Divisions</label>
    <select id="ls-divisions"></select>
    <label class="ls-label">Playoff Teams</label>
    <select id="ls-playoffs">
      <option value="6" ${league.playoff_teams === 6 ? 'selected' : ''}>6 teams — top 2 seeds get a bye</option>
      <option value="4" ${league.playoff_teams === 4 ? 'selected' : ''}>4 teams — semis &amp; championship</option>
    </select>
    <label class="ls-label">Roster Construction</label>
    <div class="roster-grid" id="ls-roster">${rosterEditorHtml('ls', leagueRoster(league))}</div>
    <p class="rc-summary" id="ls-roster-summary"></p>`
    : `<p class="form-note">🔒 Teams, divisions, playoff format, and roster construction are locked once the draft has started — the draft and schedule were built on them.</p>`;
  openModal(`
    <div class="modal-head"><h3>⚙️ League Settings</h3>
      <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="stack-form">
      <label class="ls-label">League Name</label>
      <input type="text" id="ls-name" value="${esc(league.name)}" maxlength="40"/>
      ${structure}
      <label class="ls-label">Scoring</label>
      ${presetSel}
      <details class="scoring-editor" id="ls-scoring-editor" ${preDraft ? '' : 'open'}>
        <summary>⚙️ Edit point values</summary>
        <div id="ls-scoring-grid">${scoringEditorHtml('ls', sc)}</div>
      </details>
      <p class="form-note">Scoring changes apply <b>retroactively</b>: every week of the season is re-scored from the raw stat lines, just like the big fantasy apps.
        The only exception is a live-coaching sub already made — its point split stays frozen at the values snapshotted when the sub happened.</p>
      <button class="btn-primary" onclick="saveLeagueSettings()">Save League Settings</button>
    </div>`);
  if (preDraft) {
    updateDivisionOptions('ls');
    $('ls-divisions').value = String(league.num_divisions);
    if ($('ls-divisions').value !== String(league.num_divisions)) $('ls-divisions').selectedIndex = 0;
    updateRosterSummary('ls');
  }
}

async function saveLeagueSettings() {
  if (!isCommish()) return;
  const upd = { scoring: collectScoringForm('ls') };
  const name = $('ls-name').value.trim();
  if (name) upd.name = name;
  if (league.status === 'pre_draft') {
    const num_teams = parseInt($('ls-teams').value, 10);
    const num_divisions = parseInt($('ls-divisions').value, 10);
    const playoff_teams = parseInt($('ls-playoffs').value, 10);
    if (num_teams < teams.length)
      return toast(`You already have ${teams.length} teams — can't shrink below that.`, true);
    if (num_teams % num_divisions !== 0)
      return toast('Divisions must split the teams evenly.', true);
    const roster = collectRosterForm('ls');
    if (STARTER_POS.reduce((sum, p) => sum + roster[p], 0) < 1)
      return toast('Your roster needs at least one starting spot!', true);
    Object.assign(upd, { num_teams, num_divisions, playoff_teams, roster });
  }
  const { error } = await sb.from('ff_leagues').update(upd).eq('id', league.id);
  if (error) return toast(error.message, true);
  await loadLeague(league.id);
  closeModal();
  renderTab();
  toast('League rules updated — all scores recalculated ✓');
}

// League rules summary shown in Draft Central / Draft Recap
function leagueRulesHtml(l) {
  const r = leagueRoster(l);
  const sc = leagueScoring(l);
  const rosterLine = ROSTER_EDIT.filter(({ pos }) => r[pos] > 0)
    .map(({ pos, label }) => `${r[pos]} ${label}`).join(' · ');
  const fmtRule = (d) => {
    const v = sc[d.key];
    if (d.yardage) {
      const w = v && v.whole;
      return `${v.pts} pt${Math.abs(v.pts) === 1 ? '' : 's'} per ${v.per} yds${w ? ' (whole chunks only)' : ''}`;
    }
    return `${v} pt${Math.abs(v) === 1 ? '' : 's'}`;
  };
  return `<details class="rules-details"><summary>⚙️ League rules — roster &amp; scoring</summary>
    <p class="panel-sub" style="margin-top:8px"><b>Rosters:</b> ${rosterLine} (${rosterSize(l)} players, ${starterCount(l)} start)</p>
    <div class="rules-grid">${SCORING_DEFS.map((d) => `<div class="rules-row"><span>${d.label}</span><span>${fmtRule(d)}</span></div>`).join('')}</div>
    <p class="form-note">D/ST points allowed: 0 → 10 · 1–6 → 7 · 7–13 → 4 · 14–20 → 1 · 21–27 → 0 · 28–34 → −1 · 35+ → −4</p>
  </details>`;
}

function updateDivisionOptions(prefix = 'cl') {
  const n = parseInt($(`${prefix}-teams`).value, 10);
  const sel = $(`${prefix}-divisions`);
  sel.innerHTML = '';
  const opts = [1, 2, 3, 4].filter((d) => d === 1 || (n % d === 0 && n / d >= 2));
  opts.forEach((d) => {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = d === 1 ? 'No divisions' : `${d} divisions of ${n / d}`;
    sel.appendChild(o);
  });
}

// ---------- auth ----------
function showAuthTab(tab) {
  $('tab-login').classList.toggle('active', tab === 'login');
  $('tab-signup').classList.toggle('active', tab === 'signup');
  $('login-form').classList.toggle('hidden', tab !== 'login');
  $('signup-form').classList.toggle('hidden', tab !== 'signup');
  authError('');
}
function authError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

async function handleLogin(e) {
  e.preventDefault();
  const email = $('login-email').value.trim().toLowerCase();
  const { data, error } = await sb.from('ff_players').select('*').eq('email', email).maybeSingle();
  if (error) return authError(error.message);
  if (!data) return authError('No account found with that email. Sign up to join!');
  me = data;
  localStorage.setItem('ff_player_id', me.id);
  enterHub();
}

async function handleSignup(e) {
  e.preventDefault();
  const name = $('signup-name').value.trim();
  const username = $('signup-username').value.trim().toLowerCase();
  const email = $('signup-email').value.trim().toLowerCase();
  const age_range = $('signup-age').value;
  const favorite_team = $('signup-team').value;
  if (!name || !username || !email || !age_range || !favorite_team) return;
  const { data, error } = await sb.from('ff_players')
    .insert({ name, username, email, age_range, favorite_team })
    .select().single();
  if (error) {
    if (error.code === '23505') {
      return authError(error.message.includes('username')
        ? 'That username is taken — try another.'
        : 'That email is already registered — sign in instead.');
    }
    return authError(error.message);
  }
  me = data;
  localStorage.setItem('ff_player_id', me.id);
  enterHub();
}

function logout() {
  localStorage.removeItem('ff_player_id');
  me = null;
  stopTimers();
  showAuthTab('login');
  showScreen('auth');
}

// ---------- league hub ----------
async function enterHub() {
  stopTimers();
  league = null;
  showScreen('hub');
  $('hub-user-chip').textContent = `👤 ${me.name} (@${me.username})`;
  await loadHub();
  renderHub();
  const joinCode = new URLSearchParams(location.search).get('join');
  if (joinCode) {
    $('jl-code').value = joinCode.toUpperCase();
    toast('Invite code filled in — enter a team name to join! 📨');
    $('jl-teamname').focus();
  }
}

async function loadHub() {
  const { data: mine } = await sb.from('ff_teams').select('*').eq('owner_id', me.id);
  myTeams = mine || [];
  const ids = myTeams.map((t) => t.league_id);
  if (!ids.length) { hubLeagues = []; return; }
  const [{ data: lg }, { data: allTeams }] = await Promise.all([
    sb.from('ff_leagues').select('*').in('id', ids),
    sb.from('ff_teams').select('id, league_id').in('league_id', ids),
  ]);
  hubLeagues = (lg || []).map((l) => ({
    ...l,
    filled: (allTeams || []).filter((t) => t.league_id === l.id).length,
    myTeam: myTeams.find((t) => t.league_id === l.id),
  })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

const STATUS_LABEL = { pre_draft: 'Pre-Draft', drafting: 'Drafting!', active: 'In Season', complete: 'Complete' };

function renderHub() {
  $('my-leagues').innerHTML = hubLeagues.length ? hubLeagues.map((l) => `
    <div class="league-card" onclick="openLeague('${l.id}')">
      <div>
        <div class="lc-name">🏟️ ${esc(l.name)}</div>
        <div class="lc-meta">Your team: <b>${esc(l.myTeam?.name || '—')}</b> · ${l.filled}/${l.num_teams} teams
          · ${l.num_divisions > 1 ? `${l.num_divisions} divisions · ` : ''}${l.playoff_teams}-team playoffs</div>
      </div>
      <span class="status-pill ${l.status}">${STATUS_LABEL[l.status]}</span>
    </div>`).join('')
    : '<p class="empty-note">No leagues yet — create one below or join with an invite code.</p>';
}

function randomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function handleCreateLeague(e) {
  e.preventDefault();
  const name = $('cl-name').value.trim();
  const num_teams = parseInt($('cl-teams').value, 10);
  const num_divisions = parseInt($('cl-divisions').value, 10);
  const playoff_teams = parseInt($('cl-playoffs').value, 10);
  const draftLocal = $('cl-draft').value;
  const teamName = $('cl-teamname').value.trim();
  if (!name || !teamName || !draftLocal) return;
  const roster = collectRosterForm('cl');
  if (STARTER_POS.reduce((sum, p) => sum + roster[p], 0) < 1)
    return toast('Your roster needs at least one starting spot!', true);
  const scoring = collectScoringForm('cl');
  const { data: lg, error } = await sb.from('ff_leagues').insert({
    name, commissioner_id: me.id, season: SEASON,
    num_teams, num_divisions, playoff_teams,
    roster, scoring,
    invite_code: randomCode(),
    draft_at: new Date(draftLocal).toISOString(),
  }).select().single();
  if (error) return toast(error.message, true);
  const { error: e2 } = await sb.from('ff_teams')
    .insert({ league_id: lg.id, owner_id: me.id, name: teamName });
  if (e2) return toast(e2.message, true);
  toast(`League created! Invite code: ${lg.invite_code} 🎉`);
  openLeague(lg.id);
}

async function handleJoinLeague(e) {
  e.preventDefault();
  const code = $('jl-code').value.trim().toUpperCase();
  const teamName = $('jl-teamname').value.trim();
  if (!code || !teamName) return;
  const { data: lg, error } = await sb.from('ff_leagues').select('*').eq('invite_code', code).maybeSingle();
  if (error) return toast(error.message, true);
  if (!lg) return toast('No league found with that invite code.', true);
  if (lg.status !== 'pre_draft') return toast('That league has already drafted — ask for a new league!', true);
  const { data: existing } = await sb.from('ff_teams').select('id, owner_id').eq('league_id', lg.id);
  if ((existing || []).some((t) => t.owner_id === me.id)) { openLeague(lg.id); return; }
  if ((existing || []).length >= lg.num_teams) return toast('That league is already full.', true);
  const { error: e2 } = await sb.from('ff_teams')
    .insert({ league_id: lg.id, owner_id: me.id, name: teamName });
  if (e2) return toast(e2.code === '23505' ? 'You already have a team in this league.' : e2.message, true);
  toast(`Welcome to ${lg.name}! 🏈`);
  history.replaceState(null, '', location.pathname);
  openLeague(lg.id);
}

function backToHub() { enterHub(); }

// ---------- league loading ----------
function regularWeeks(l) { return l.playoff_teams === 6 ? FANTASY_WEEKS - 3 : FANTASY_WEEKS - 2; }
function playoffWeeks(l) {
  const start = regularWeeks(l) + 1;
  return Array.from({ length: FANTASY_WEEKS - regularWeeks(l) }, (_, i) => start + i);
}
const myTeam = () => teams.find((t) => t.owner_id === me.id);
const isCommish = () => league && league.commissioner_id === me.id;

async function openLeague(id) {
  showScreen('league');
  $('league-title').textContent = '…';
  await loadLeague(id);
  await ensureNflPlayers();
  await detectCurrentWeek();
  selectedWeek = Math.min(currentNflWeek, FANTASY_WEEKS);
  activeTab = league.status === 'active' || league.status === 'complete' ? 'team' : 'draft';
  $('user-chip').textContent = `👤 ${me.name}`;
  $('settings-btn').classList.toggle('hidden', !isCommish());
  showTab(activeTab);
  startLiveTimer();
}

async function loadLeague(id) {
  const [{ data: lg }, { data: tm }] = await Promise.all([
    sb.from('ff_leagues').select('*').eq('id', id).single(),
    sb.from('ff_teams').select('*').eq('league_id', id).order('created_at'),
  ]);
  league = lg;
  teams = tm || [];
  const [ro, dp, mu, sw] = await Promise.all([
    sb.from('ff_rosters').select('*').eq('league_id', id),
    sb.from('ff_draft_picks').select('*').eq('league_id', id).order('overall'),
    sb.from('ff_matchups').select('*').eq('league_id', id),
    sb.from('ff_swaps').select('*').eq('league_id', id),
  ]);
  rosters = ro.data || [];
  draftPicks = dp.data || [];
  matchupsAll = mu.data || [];
  swapsAll = sw.data || [];
  $('league-title').textContent = league.name;
}

// ---------- NFL player pool (ESPN rosters) ----------
async function ensureNflPlayers() {
  const rows = await fetchAll(() => sb.from('ff_nfl_players').select('*'));
  nflPlayers = new Map(rows.map((p) => [p.id, p]));
  const lastSync = Number(localStorage.getItem('ff_roster_sync') || 0);
  const stale = Date.now() - lastSync > 7 * 24 * 3600e3;
  if (nflPlayers.size < 100) {
    toast('First run — syncing NFL players from ESPN… ⏳');
    await syncNflPlayers();
    toast(`NFL player pool ready (${nflPlayers.size} players) ✓`);
  } else if (stale) {
    syncNflPlayers(); // background refresh (team changes, rookies, etc.)
  }
}

const POS_FIX = { PK: 'K', FB: 'RB' };
async function syncNflPlayers() {
  const upserts = [];
  const seen = new Set();
  let teamsSynced = 0;
  for (const [abbr, t] of Object.entries(TEAMS)) {
    upserts.push({
      id: `DST-${abbr}`, name: `${t.city} ${t.name} D/ST`, position: 'DST',
      team: abbr, headshot: teamLogo(abbr), jersey: null,
      updated_at: new Date().toISOString(),
    });
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${t.espnId}/roster`);
      if (!res.ok) continue;
      const data = await res.json();
      teamsSynced++;
      for (const group of data.athletes || []) {
        for (const a of group.items || []) {
          seen.add(String(a.id));
          const pos = POS_FIX[a.position?.abbreviation] || a.position?.abbreviation;
          if (!['QB', 'RB', 'WR', 'TE', 'K'].includes(pos)) continue;
          upserts.push({
            id: String(a.id), name: a.displayName, position: pos, team: abbr,
            headshot: a.headshot?.href || `https://a.espncdn.com/i/headshots/nfl/players/full/${a.id}.png`,
            jersey: a.jersey || null, updated_at: new Date().toISOString(),
          });
        }
      }
    } catch (err) { console.warn('Roster sync failed for', abbr, err); }
  }
  for (let i = 0; i < upserts.length; i += 400) {
    const chunk = upserts.slice(i, i + 400);
    const { error } = await sb.from('ff_nfl_players').upsert(chunk, { onConflict: 'id' });
    if (error) { console.warn(error); return; }
    chunk.forEach((p) => nflPlayers.set(p.id, p));
  }
  // Reconcile: a player on no ESPN roster is a free agent (seeded data can be stale)
  if (teamsSynced === Object.keys(TEAMS).length && seen.size > 500) {
    const stale = [...nflPlayers.values()]
      .filter((p) => p.position !== 'DST' && p.team && !seen.has(p.id))
      .map((p) => p.id);
    for (let i = 0; i < stale.length; i += 200) {
      const ids = stale.slice(i, i + 200);
      const { error } = await sb.from('ff_nfl_players')
        .update({ team: null, updated_at: new Date().toISOString() }).in('id', ids);
      if (!error) ids.forEach((id) => { nflPlayers.get(id).team = null; });
    }
  }
  localStorage.setItem('ff_roster_sync', String(Date.now()));
}

// ---------- NFL schedule / live events (ESPN scoreboard) ----------
async function detectCurrentWeek() {
  try {
    const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
    const data = await res.json();
    if (data.season?.year === SEASON && data.season?.type === 2) {
      currentNflWeek = Math.min(data.week?.number || 1, FANTASY_WEEKS);
    } else if (data.season?.year === SEASON && data.season?.type === 3) {
      currentNflWeek = FANTASY_WEEKS;
    } else if (data.season?.year > SEASON) {
      currentNflWeek = FANTASY_WEEKS;
    } else {
      currentNflWeek = 1;
    }
  } catch { currentNflWeek = 1; }
}

async function fetchWeekEvents(week, force = false) {
  const key = `ff_ev_${SEASON}_${week}`;
  const cached = JSON.parse(localStorage.getItem(key) || 'null');
  const allFinal = cached && cached.events.length && cached.events.every((e) => e.completed);
  if (cached && (allFinal || (!force && Date.now() - cached.ts < 45e3))) {
    eventsByWeek[week] = cached.events;
    return cached.events;
  }
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${SEASON}&seasontype=2&week=${week}`);
    const data = await res.json();
    const events = (data.events || []).map((ev) => {
      const comp = ev.competitions?.[0] || {};
      const home = comp.competitors?.find((c) => c.homeAway === 'home');
      const away = comp.competitors?.find((c) => c.homeAway === 'away');
      return {
        id: String(ev.id), date: ev.date,
        state: ev.status?.type?.state || 'pre',
        completed: !!ev.status?.type?.completed,
        detail: ev.status?.type?.shortDetail || '',
        home: normAbbr(home?.team?.abbreviation), away: normAbbr(away?.team?.abbreviation),
        homeScore: Number(home?.score || 0), awayScore: Number(away?.score || 0),
      };
    });
    eventsByWeek[week] = events;
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), events }));
    return events;
  } catch (err) {
    console.warn('scoreboard fetch failed', err);
    return eventsByWeek[week] || (cached ? cached.events : []);
  }
}

const teamEvent = (abbr, week) =>
  (eventsByWeek[week] || []).find((e) => e.home === abbr || e.away === abbr);
const eventStarted = (e) => e && (e.state !== 'pre' || new Date(e.date) <= new Date());
const weekComplete = (week) => {
  const evs = eventsByWeek[week] || [];
  return evs.length > 0 && evs.every((e) => e.completed);
};

// ---------- stats sync (ESPN box scores → ff_player_week_stats) ----------
async function syncStats(week, force = false) {
  if (!force && Date.now() - (statsSyncAt[week] || 0) < STATS_SYNC_MS) return;
  statsSyncAt[week] = Date.now();
  const events = await fetchWeekEvents(week, force);
  const started = events.filter((e) => e.state !== 'pre');
  const upserts = [];
  for (const ev of started) {
    const doneKey = `ff_done_${SEASON}_${week}_${ev.id}`;
    if (ev.completed && localStorage.getItem(doneKey)) continue;
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${ev.id}`);
      if (!res.ok) continue;
      const summary = await res.json();
      upserts.push(...parseSummary(summary, ev, week));
      if (ev.completed) localStorage.setItem(doneKey, '1');
    } catch (err) { console.warn('summary fetch failed', ev.id, err); }
  }
  for (let i = 0; i < upserts.length; i += 400) {
    const { error } = await sb.from('ff_player_week_stats')
      .upsert(upserts.slice(i, i + 400), { onConflict: 'season,week,nfl_player_id' });
    if (error) console.warn(error);
  }
  await loadStats(week);
}

async function loadStats(week) {
  const rows = await fetchAll(() =>
    sb.from('ff_player_week_stats').select('*').eq('season', SEASON).eq('week', week));
  statsByWeek[week] = new Map(rows.map((r) => [r.nfl_player_id, r]));
}

function parseSummary(summary, ev, week) {
  const status = ev.completed ? 'final' : (ev.state === 'in' ? 'in_progress' : 'scheduled');
  const rows = new Map();
  const dst = {}; // abbr -> aggregates
  const teamKicker = {};
  const mk = (pid, team) => {
    if (!rows.has(pid)) {
      rows.set(pid, {
        season: SEASON, week, nfl_player_id: pid, team,
        opponent: team === ev.home ? ev.away : ev.home,
        game_espn_id: ev.id, game_status: status, game_clock: ev.detail,
        stats: {}, points: 0, updated_at: new Date().toISOString(),
      });
    }
    return rows.get(pid).stats;
  };
  [ev.home, ev.away].forEach((t) => {
    dst[t] = { sacks: 0, ints: 0, fumRec: 0, tds: 0, safeties: 0, fgBonus: {} };
  });
  const oppLost = { [ev.home]: 0, [ev.away]: 0 };

  for (const teamBlock of summary.boxscore?.players || []) {
    const abbr = normAbbr(teamBlock.team?.abbreviation);
    for (const cat of teamBlock.statistics || []) {
      const idx = {};
      (cat.labels || []).forEach((l, i) => { idx[l] = i; });
      for (const a of cat.athletes || []) {
        const pid = String(a.athlete?.id);
        const s = a.stats || [];
        const get = (label) => num(s[idx[label]]);
        const known = nflPlayers.has(pid);
        switch (cat.name) {
          case 'passing':
            if (known) Object.assign(mk(pid, abbr), {
              passComp: (s[idx['C/ATT']] || '').split('/')[0] | 0,
              passAtt: (s[idx['C/ATT']] || '').split('/')[1] | 0,
              passYds: get('YDS'), passTD: get('TD'), passInt: get('INT'),
            });
            break;
          case 'rushing':
            if (known) Object.assign(mk(pid, abbr), { rushAtt: get('CAR'), rushYds: get('YDS'), rushTD: get('TD') });
            break;
          case 'receiving':
            if (known) Object.assign(mk(pid, abbr), { rec: get('REC'), recYds: get('YDS'), recTD: get('TD') });
            break;
          case 'fumbles':
            if (known) Object.assign(mk(pid, abbr), { fumLost: get('LOST') });
            oppLost[abbr] += get('LOST');
            break;
          case 'kicking': {
            const [fgM, fgA] = (s[idx['FG']] || '0/0').split('/').map(Number);
            const [xpM, xpA] = (s[idx['XP']] || '0/0').split('/').map(Number);
            if (known) Object.assign(mk(pid, abbr), { fgMade: fgM || 0, fgAtt: fgA || 0, xpMade: xpM || 0, xpAtt: xpA || 0 });
            if (known && !teamKicker[abbr]) teamKicker[abbr] = pid;
            break;
          }
          case 'defensive':
            if (dst[abbr]) { dst[abbr].sacks += get('SACKS'); dst[abbr].tds += get('TD'); }
            break;
          case 'interceptions':
            // (pick-six TDs already counted in the 'defensive' category)
            if (dst[abbr]) dst[abbr].ints += get('INT');
            break;
          case 'kickReturns':
          case 'puntReturns':
            if (dst[abbr]) dst[abbr].tds += get('TD');
            break;
        }
      }
    }
  }

  // Scoring plays: FG distance bonuses + safeties
  for (const sp of summary.scoringPlays || []) {
    const t = normAbbr(sp.team?.abbreviation);
    const text = sp.text || '';
    if (/field goal/i.test(text)) {
      const m = text.match(/(\d+)\s*[Yy]a?r?d/);
      const yds = m ? parseInt(m[1], 10) : 0;
      const kicker = teamKicker[t];
      if (kicker && yds >= 40) {
        const st = mk(kicker, t);
        st.fgBonus = (st.fgBonus || 0) + (yds >= 50 ? 2 : 1);
      }
    }
    if (/safety/i.test(text) && dst[t]) dst[t].safeties += 1;
  }

  // D/ST rows
  [ev.home, ev.away].forEach((abbr) => {
    const opp = abbr === ev.home ? ev.away : ev.home;
    const pa = abbr === ev.home ? ev.awayScore : ev.homeScore;
    const d = dst[abbr];
    d.fumRec = oppLost[opp];
    d.pointsAllowed = pa;
    const pid = `DST-${abbr}`;
    if (nflPlayers.has(pid)) Object.assign(mk(pid, abbr), d);
  });

  for (const r of rows.values()) {
    r.points = scoreStats(r.stats, r.nfl_player_id.startsWith('DST-'));
  }
  return [...rows.values()];
}

function scoreStatsWith(st, isDst, sc) {
  const n = (v) => Number(v) || 0;
  if (isDst) {
    return Math.round((
      (st.sacks || 0) * n(sc.dstSack) + (st.ints || 0) * n(sc.dstInt)
      + (st.fumRec || 0) * n(sc.dstFumRec) + (st.tds || 0) * n(sc.dstTD)
      + (st.safeties || 0) * n(sc.dstSafety)
      + dstPaPoints(st.pointsAllowed ?? 0)) * 100) / 100;
  }
  // fgBonus stat is stored in "standard bonus units" (1 per 40–49, 2 per 50+);
  // custom leagues rescale it: units of 40-49s ≈ fg40 pts, 50+ pairs ≈ fg50.
  const fgBonusPts = (st.fgBonus || 0) === 0 ? 0
    : (st.fgBonus || 0) * ((n(sc.fg40) + n(sc.fg50)) / 3 || 0);
  return Math.round((
    yardPts(st.passYds || 0, sc.passYds) + (st.passTD || 0) * n(sc.passTD)
    + (st.passInt || 0) * n(sc.passInt)
    + yardPts(st.rushYds || 0, sc.rushYds) + (st.rushTD || 0) * n(sc.rushTD)
    + (st.rec || 0) * n(sc.rec) + yardPts(st.recYds || 0, sc.recYds)
    + (st.recTD || 0) * n(sc.recTD)
    + (st.fumLost || 0) * n(sc.fumLost)
    + (st.fgMade || 0) * n(sc.fg) + fgBonusPts
    + (st.xpMade || 0) * n(sc.xp)) * 100) / 100;
}
// The shared stats cache always stores standard-scoring points; every league
// re-scores the raw stat line with its own rules.
const scoreStats = (st, isDst) => scoreStatsWith(st, isDst, DEFAULT_SCORING);

const statRow = (pid, week) => (statsByWeek[week] || new Map()).get(pid);
const playerPts = (pid, week) => {
  const r = statRow(pid, week);
  if (!r) return 0;
  return scoreStatsWith(r.stats || {}, String(pid).startsWith('DST-'), leagueScoring(league));
};

function statLine(pid, week) {
  const r = statRow(pid, week);
  if (!r) return '';
  const st = r.stats || {};
  const bits = [];
  if (st.passYds || st.passTD || st.passInt) bits.push(`${st.passComp || 0}/${st.passAtt || 0}, ${st.passYds || 0} pa yds${st.passTD ? `, ${st.passTD} TD` : ''}${st.passInt ? `, ${st.passInt} INT` : ''}`);
  if (st.rushYds || st.rushTD) bits.push(`${st.rushYds || 0} ru yds${st.rushTD ? `, ${st.rushTD} TD` : ''}`);
  if (st.rec || st.recYds || st.recTD) bits.push(`${st.rec || 0} rec, ${st.recYds || 0} yds${st.recTD ? `, ${st.recTD} TD` : ''}`);
  if (st.fgMade != null || st.xpMade != null) bits.push(`FG ${st.fgMade || 0}/${st.fgAtt || 0}, XP ${st.xpMade || 0}/${st.xpAtt || 0}`);
  if (st.sacks != null) bits.push(`${st.sacks} sck, ${st.ints} int, ${st.pointsAllowed} PA`);
  if (st.fumLost) bits.push(`${st.fumLost} fum lost`);
  return bits.join(' · ');
}

// ---------- lineups ----------
async function loadLineups(week) {
  const { data } = await sb.from('ff_lineups').select('*')
    .eq('league_id', league.id).eq('week', week);
  lineupsByWeek[week] = data || [];
}

const lineupRow = (teamId, week, slot) =>
  (lineupsByWeek[week] || []).find((l) => l.team_id === teamId && l.slot === slot);
const teamLineup = (teamId, week) =>
  (lineupsByWeek[week] || []).filter((l) => l.team_id === teamId);
const swapFor = (teamId, week, slot) =>
  swapsAll.find((s) => s.team_id === teamId && s.week === week && s.slot === slot);
const teamSwaps = (teamId, week) =>
  swapsAll.filter((s) => s.team_id === teamId && s.week === week);
const rosterOf = (teamId) => rosters.filter((r) => r.team_id === teamId)
  .map((r) => nflPlayers.get(r.nfl_player_id)).filter(Boolean)
  .sort((a, b) => (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9) || a.name.localeCompare(b.name));

async function ensureLineup(teamId, week) {
  if (league.status !== 'active' && league.status !== 'complete') return;
  if (week < currentNflWeek) return; // don't fabricate the past
  if (teamLineup(teamId, week).length) return;
  const roster = rosterOf(teamId);
  if (!roster.length) return;
  // Start from the most recent saved lineup, else auto-fill by position
  let prev = [];
  for (let w = week - 1; w >= 1; w--) {
    if (!lineupsByWeek[w]) {
      const { data } = await sb.from('ff_lineups').select('*')
        .eq('league_id', league.id).eq('week', w).eq('team_id', teamId);
      if (data?.length) { prev = data; break; }
    } else if (teamLineup(teamId, w).length) { prev = teamLineup(teamId, w); break; }
    if (w < week - 3) break;
  }
  const used = new Set();
  const assign = {};
  const slots = leagueSlots(league);
  for (const slot of slots) {
    const p = prev.find((l) => l.slot === slot);
    const pl = p && nflPlayers.get(p.nfl_player_id);
    if (pl && roster.some((r) => r.id === pl.id) && slotEligible(slot).includes(pl.position) && !used.has(pl.id)) {
      assign[slot] = pl.id; used.add(pl.id);
    }
  }
  for (const slot of slots) {
    if (assign[slot]) continue;
    const pl = roster.find((r) => slotEligible(slot).includes(r.position) && !used.has(r.id));
    if (pl) { assign[slot] = pl.id; used.add(pl.id); }
  }
  const inserts = slots.filter((s) => assign[s]).map((s) => ({
    league_id: league.id, team_id: teamId, week, slot: s, nfl_player_id: assign[s],
  }));
  if (!inserts.length) return;
  const { data, error } = await sb.from('ff_lineups').insert(inserts).select();
  if (!error && data) lineupsByWeek[week] = [...(lineupsByWeek[week] || []), ...data];
  else if (error && error.code === '23505') await loadLineups(week);
}

// The heart of scoring: a slot's points, honoring a live-coaching swap.
// out player: only points scored BEFORE the sub count (snapshotted at swap time).
// in player: only points scored AFTER the sub count (current minus snapshot).
function slotScore(teamId, week, slot) {
  const swap = swapFor(teamId, week, slot);
  if (swap) {
    const inNow = playerPts(swap.in_player_id, week);
    const pts = Number(swap.out_points_at_swap) + (inNow - Number(swap.in_points_at_swap));
    return { pts: Math.round(pts * 100) / 100, swap, playerId: swap.in_player_id };
  }
  const lr = lineupRow(teamId, week, slot);
  const pid = lr?.nfl_player_id || null;
  return { pts: pid ? playerPts(pid, week) : 0, swap: null, playerId: pid };
}

const teamWeekScore = (teamId, week) =>
  Math.round(leagueSlots(league).reduce((sum, s) => sum + slotScore(teamId, week, s).pts, 0) * 100) / 100;

function playerLocked(pid, week) {
  const p = nflPlayers.get(pid);
  if (!p || !p.team) return false;
  return eventStarted(teamEvent(p.team, week));
}

// ---------- tabs / navigation ----------
function stopTimers() {
  clearInterval(draftPollTimer); draftPollTimer = null;
  clearInterval(liveTimer); liveTimer = null;
}

function startLiveTimer() {
  clearInterval(liveTimer);
  liveTimer = setInterval(async () => {
    if (document.hidden || !league) return;
    if (!['team', 'matchup'].includes(activeTab)) return;
    const evs = eventsByWeek[selectedWeek] || [];
    if (!evs.some((e) => e.state === 'in')) return;
    await syncStats(selectedWeek);
    renderTab();
  }, 75e3);
}

function showTab(tab) {
  activeTab = tab;
  ['team', 'matchup', 'players', 'standings', 'draft'].forEach((t) => {
    $(`tab-${t}`).classList.toggle('hidden', t !== tab);
    $(`nav-${t}`).classList.toggle('active', t === tab);
  });
  $('nav-draft').innerHTML = league.status === 'drafting' ? 'Draft<span class="dot"></span>' : 'Draft';
  $('week-nav').style.display = (tab === 'draft') ? 'none' : 'flex';
  renderTab();
  if (league.status === 'drafting' && tab === 'draft') startDraftPoll();
  else { clearInterval(draftPollTimer); draftPollTimer = null; }
}

function changeWeek(d) { selectWeek(Math.min(FANTASY_WEEKS, Math.max(1, selectedWeek + d))); }
function selectWeek(w) { selectedWeek = w; renderTab(); }

async function manualRefresh() {
  toast('Refreshing…');
  await loadLeague(league.id);
  await syncStats(selectedWeek, true);
  await loadLineups(selectedWeek);
  renderTab();
  toast('Up to date ✓');
}

function renderWeekPills() {
  const reg = regularWeeks(league);
  $('week-pills').innerHTML = Array.from({ length: FANTASY_WEEKS }, (_, i) => i + 1)
    .map((w) => `<button class="week-pill ${w === selectedWeek ? 'active' : ''} ${w === currentNflWeek ? 'current-week' : ''} ${w > reg ? 'playoff-pill' : ''}"
      onclick="selectWeek(${w})" title="${w > reg ? 'Playoffs' : 'Week ' + w}">${w > reg ? '🏆' : ''}W${w}</button>`).join('');
}

async function renderTab() {
  if (!league) return;
  renderWeekPills();
  if (activeTab === 'team') await renderTeamTab();
  if (activeTab === 'matchup') await renderMatchupTab();
  if (activeTab === 'players') await renderPlayersTabAsync();
  if (activeTab === 'standings') await renderStandingsTab();
  if (activeTab === 'draft') renderDraftTab();
}

// ---------- MY TEAM tab ----------
async function renderTeamTab() {
  const el = $('team-view');
  const mine = myTeam();
  if (league.status === 'pre_draft' || league.status === 'drafting') {
    el.innerHTML = `<div class="panel"><h2>🧢 ${esc(mine?.name || 'My Team')}</h2>
      <p class="empty-note">Your roster appears here after the draft. Head to the <b>Draft</b> tab!</p></div>`;
    return;
  }
  el.innerHTML = '<div class="panel"><p class="empty-note">Loading lineup…</p></div>';
  await fetchWeekEvents(selectedWeek);
  if (!statsByWeek[selectedWeek]) await loadStats(selectedWeek);
  syncStats(selectedWeek); // background freshen (throttled)
  if (!lineupsByWeek[selectedWeek]) await loadLineups(selectedWeek);
  await ensureLineup(mine.id, selectedWeek);

  const roster = rosterOf(mine.id);
  const lineup = teamLineup(mine.id, selectedWeek);
  const starters = new Set(lineup.map((l) => l.nfl_player_id));
  const swapIns = new Set(teamSwaps(mine.id, selectedWeek).map((s) => s.in_player_id));
  const bench = roster.filter((p) => !starters.has(p.id));
  const total = teamWeekScore(mine.id, selectedWeek);

  const slotRows = leagueSlots(league).map((slot) => renderSlotRow(mine.id, slot)).join('');
  const benchRows = bench.map((p) => {
    const subbedIn = swapIns.has(p.id);
    return playerRowHtml(p, selectedWeek, {
      tag: 'BN',
      note: subbedIn ? '🎧 subbed in — scoring in your lineup' : '',
      benchPts: !subbedIn,
    });
  }).join('') || '<p class="empty-note">No bench players.</p>';

  el.innerHTML = `
    <div class="lineup-grid">
      <div class="panel">
        <div class="standings-head">
          <h2>🧢 ${esc(mine.name)} — Week ${selectedWeek}</h2>
          <span class="mu-score">${fmtPts(total)}</span>
        </div>
        <p class="panel-sub coach-hint"><svg class="coach-mid"><use href="#coach"/></svg>
          <span>Starters lock at their game's kickoff. Once a game is <span class="live-badge">LIVE</span>, coach it like the sideline: <b style="color:var(--purple)">one live sub per position</b> — the 🎧 button.</span></p>
        ${slotRows}
      </div>
      <div class="panel">
        <h3>🪑 Bench</h3>
        <p class="panel-sub">Bench points never count — unless you coach them in live.</p>
        ${benchRows}
      </div>
    </div>`;
}

function gameMetaHtml(p, week) {
  if (!p.team) return '<span class="final">FA</span>';
  const ev = teamEvent(p.team, week);
  if (!ev) return '<span>BYE</span>';
  const opp = ev.home === p.team ? `vs ${ev.away}` : `@ ${ev.home}`;
  if (ev.completed) return `<span class="final">Final</span> ${opp} ${ev.awayScore}–${ev.homeScore}`;
  if (ev.state === 'in') return `<span class="live">● ${esc(ev.detail)}</span> ${opp} ${ev.awayScore}–${ev.homeScore}`;
  return `${opp} · ${new Date(ev.date).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function playerRowHtml(p, week, opts = {}) {
  const line = statLine(p.id, week);
  const pts = playerPts(p.id, week);
  return `<div class="slot-row">
    ${opts.tag ? `<span class="slot-tag">${opts.tag}</span>` : ''}
    <img class="headshot" src="${esc(p.headshot || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
    <div class="p-info">
      <div class="p-name" onclick="openProfile('${p.id}')">${esc(p.name)} <span class="pos-badge pos-${p.position}">${p.position}</span></div>
      <div class="p-meta">${gameMetaHtml(p, week)}${line ? ` · ${esc(line)}` : ''}${opts.note ? ` · <b style="color:var(--purple)">${opts.note}</b>` : ''}</div>
    </div>
    <div class="p-pts" ${opts.benchPts ? 'style="color:var(--muted)"' : ''}>${fmtPts(pts)}${opts.benchPts ? '<small>bench</small>' : ''}</div>
  </div>`;
}

function renderSlotRow(teamId, slot) {
  const week = selectedWeek;
  const { pts, swap, playerId } = slotScore(teamId, week, slot);
  const isMine = teamId === myTeam()?.id;
  const lr = lineupRow(teamId, week, slot);
  const basePid = lr?.nfl_player_id;

  if (swap) {
    const outP = nflPlayers.get(swap.out_player_id);
    const inP = nflPlayers.get(swap.in_player_id);
    const inEarned = playerPts(swap.in_player_id, week) - Number(swap.in_points_at_swap);
    return `<div class="slot-row swapped">
        <span class="slot-tag">${slotLabel(slot, league)}</span>
        <img class="headshot" src="${esc(inP?.headshot || '')}" alt="" onerror="this.style.visibility='hidden'"/>
        <div class="p-info">
          <div class="p-name" onclick="openProfile('${inP?.id}')">🎧 ${esc(inP?.name || '?')} <span class="pos-badge pos-${inP?.position}">${inP?.position || ''}</span></div>
          <div class="p-meta">${inP ? gameMetaHtml(inP, week) : ''}</div>
        </div>
        <div class="p-pts">${fmtPts(pts)}</div>
      </div>
      <div class="swap-detail">🎧 <b>Live sub</b> at ${new Date(swap.swapped_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${swap.game_clock ? ` (${esc(swap.game_clock)})` : ''}:
        <b>${esc(outP?.name || '?')}</b> out, locked at <b>${fmtPts(Number(swap.out_points_at_swap))}</b> pts ·
        <b>${esc(inP?.name || '?')}</b> in from <b>${fmtPts(Number(swap.in_points_at_swap))}</b> pts (<b>+${fmtPts(inEarned)}</b> since the sub)</div>`;
  }

  if (!basePid) {
    return `<div class="slot-row empty-slot">
      <span class="slot-tag">${slotLabel(slot, league)}</span>
      <div class="p-info"><div class="p-meta">Empty slot</div></div>
      ${isMine ? `<div class="slot-actions"><button class="btn-small" onclick="openSlotPicker('${slot}')">Set</button></div>` : ''}
    </div>`;
  }

  const p = nflPlayers.get(basePid);
  if (!p) return '';
  const ev = p.team ? teamEvent(p.team, week) : null;
  const locked = eventStarted(ev);
  const live = ev && ev.state === 'in';
  const canLiveSub = isMine && live && !swap && liveSubCandidates(slot).length > 0;
  const actions = !isMine ? '' : locked
    ? `<div class="slot-actions">${canLiveSub
        ? `<button class="btn-small purple" title="Live coaching sub" onclick="openLiveSub('${slot}')">🎧 Sub</button>`
        : (live ? '' : '<span class="lock-badge" title="Locked at kickoff">🔒</span>')}</div>`
    : `<div class="slot-actions"><button class="btn-small" onclick="openSlotPicker('${slot}')">Change</button></div>`;

  return `<div class="slot-row ${locked ? 'locked' : ''} ${live ? 'live-game' : ''}">
    <span class="slot-tag">${slotLabel(slot, league)}</span>
    <img class="headshot" src="${esc(p.headshot || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
    <div class="p-info">
      <div class="p-name" onclick="openProfile('${p.id}')">${esc(p.name)} <span class="pos-badge pos-${p.position}">${p.position}</span></div>
      <div class="p-meta">${gameMetaHtml(p, week)}${statLine(p.id, week) ? ` · ${esc(statLine(p.id, week))}` : ''}</div>
    </div>
    <div class="p-pts">${fmtPts(pts)}</div>
    ${actions}</div>`;
}

// ---- normal (pre-kickoff) lineup changes ----
function openSlotPicker(slot) {
  const mine = myTeam();
  const week = selectedWeek;
  const lineup = teamLineup(mine.id, week);
  const inSlots = new Set(lineup.map((l) => l.nfl_player_id));
  const swapPids = new Set(teamSwaps(mine.id, week).flatMap((s) => [s.in_player_id, s.out_player_id]));
  const candidates = rosterOf(mine.id).filter((p) =>
    slotEligible(slot).includes(p.position)
    && !inSlots.has(p.id)
    && !swapPids.has(p.id)
    && !playerLocked(p.id, week));
  const current = lineupRow(mine.id, week, slot);
  const curP = current && nflPlayers.get(current.nfl_player_id);
  openModal(`
    <div class="modal-head"><h3>Set ${slotLabel(slot, league)} — Week ${week}</h3>
      <button class="modal-close" onclick="closeModal()">✕</button></div>
    ${curP ? `<p class="panel-sub">Currently: <b>${esc(curP.name)}</b></p>` : ''}
    <div class="pick-list">
      ${candidates.map((p) => `
        <div class="slot-row" onclick="setSlot('${slot}','${p.id}')">
          <img class="headshot" src="${esc(p.headshot || '')}" alt="" onerror="this.style.visibility='hidden'"/>
          <div class="p-info">
            <div class="p-name">${esc(p.name)} <span class="pos-badge pos-${p.position}">${p.position}</span></div>
            <div class="p-meta">${gameMetaHtml(p, week)}</div>
          </div></div>`).join('') || '<p class="empty-note">No available players for this slot (bench empty or all locked).</p>'}
      ${curP && !playerLocked(curP.id, week) ? `<button class="btn-ghost" style="margin-top:10px" onclick="setSlot('${slot}', null)">Leave slot empty</button>` : ''}
    </div>`);
}

async function setSlot(slot, pid) {
  const mine = myTeam();
  const week = selectedWeek;
  const current = lineupRow(mine.id, week, slot);
  if (current && playerLocked(current.nfl_player_id, week))
    return toast('That player already kicked off — use a 🎧 live sub instead.', true);
  if (pid && playerLocked(pid, week))
    return toast('That player\'s game already started — too late for a normal change.', true);
  let error;
  if (current) {
    ({ error } = pid
      ? await sb.from('ff_lineups').update({ nfl_player_id: pid, updated_at: new Date().toISOString() }).eq('id', current.id)
      : await sb.from('ff_lineups').delete().eq('id', current.id));
  } else if (pid) {
    ({ error } = await sb.from('ff_lineups').insert({
      league_id: league.id, team_id: mine.id, week, slot, nfl_player_id: pid,
    }));
  }
  if (error) return toast(error.message, true);
  await loadLineups(week);
  closeModal();
  renderTab();
  toast(pid ? `${slotLabel(slot, league)} set: ${nflPlayers.get(pid)?.name} ✓` : `${slotLabel(slot, league)} emptied`);
}

// ---- LIVE COACHING ----
function liveSubCandidates(slot) {
  const mine = myTeam();
  const week = selectedWeek;
  const lineup = teamLineup(mine.id, week);
  const inSlots = new Set(lineup.map((l) => l.nfl_player_id));
  const swapPids = new Set(teamSwaps(mine.id, week).flatMap((s) => [s.in_player_id, s.out_player_id]));
  return rosterOf(mine.id).filter((p) => {
    if (!slotEligible(slot).includes(p.position)) return false;
    if (inSlots.has(p.id) || swapPids.has(p.id)) return false;
    const ev = p.team ? teamEvent(p.team, week) : null;
    if (!ev) return false;            // bye week — can't come in
    if (ev.completed) return false;   // already played — can't come in
    return true;
  });
}

function openLiveSub(slot) {
  const mine = myTeam();
  const week = selectedWeek;
  const lr = lineupRow(mine.id, week, slot);
  const outP = lr && nflPlayers.get(lr.nfl_player_id);
  if (!outP) return;
  const ev = teamEvent(outP.team, week);
  if (!ev || ev.state !== 'in') return toast('Live subs only while that player\'s game is live.', true);
  const candidates = liveSubCandidates(slot);
  const outPts = playerPts(outP.id, week);
  openModal(`
    <div class="modal-head"><h3>🎧 Live Coaching — sub out ${slotLabel(slot, league)}</h3>
      <button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="subnote with-coach"><svg class="coach-mid"><use href="#coach"/></svg>
      <span>Just like a real coach: <b>${esc(outP.name)}</b> keeps only the <b>${fmtPts(outPts)} pts</b> he's scored so far (${esc(ev.detail)}).
      Your sub scores for you <b>from this moment on</b> — anything he's already scored stays on the bench.
      <b>One live sub per position per week — no undo.</b></span></div>
    <div class="pick-list">
      ${candidates.map((p) => {
        const pev = teamEvent(p.team, week);
        const now = playerPts(p.id, week);
        const liveNote = pev.state === 'in'
          ? `already playing — his current ${fmtPts(now)} pts won't count, only points from now on`
          : `hasn't kicked off — you'll get everything he scores`;
        return `<div class="slot-row" onclick="confirmLiveSub('${slot}','${p.id}')">
          <img class="headshot" src="${esc(p.headshot || '')}" alt="" onerror="this.style.visibility='hidden'"/>
          <div class="p-info">
            <div class="p-name">${esc(p.name)} <span class="pos-badge pos-${p.position}">${p.position}</span></div>
            <div class="p-meta">${gameMetaHtml(p, week)} · <b style="color:var(--purple)">${liveNote}</b></div>
          </div></div>`;
      }).join('') || '<p class="empty-note">No eligible bench player — you can\'t sit a player without a replacement.</p>'}
    </div>`);
}

async function confirmLiveSub(slot, inPid) {
  const mine = myTeam();
  const week = selectedWeek;
  const lr = lineupRow(mine.id, week, slot);
  const outP = lr && nflPlayers.get(lr.nfl_player_id);
  const inP = nflPlayers.get(inPid);
  if (!outP || !inP) return;
  toast('Snapshotting live points…');
  await syncStats(week, true); // freeze the split at this exact moment
  const ev = teamEvent(outP.team, week);
  if (!ev || ev.state !== 'in') return toast('That game is no longer live — sub window closed.', true);
  const inEv = teamEvent(inP.team, week);
  if (!inEv || inEv.completed) return toast(`${inP.name} has already played — pick someone who hasn't.`, true);
  const outSnap = playerPts(outP.id, week);
  const inSnap = playerPts(inPid, week);
  if (!confirm(`🎧 LIVE SUB — ${slotLabel(slot, league)}\n\nOUT: ${outP.name} — locked at ${fmtPts(outSnap)} pts (${ev.detail})\nIN: ${inP.name} — scores from ${fmtPts(inSnap)} pts onward\n\nOne sub per position per week. This cannot be undone. Make the call, coach?`)) return;
  const { data, error } = await sb.from('ff_swaps').insert({
    league_id: league.id, team_id: mine.id, week, slot,
    out_player_id: outP.id, in_player_id: inPid,
    out_points_at_swap: outSnap, in_points_at_swap: inSnap,
    game_clock: ev.detail,
  }).select().single();
  if (error) {
    if (error.code === '23505') return toast('You already used your live sub for this position this week!', true);
    return toast(error.message, true);
  }
  swapsAll.push(data);
  closeModal();
  renderTab();
  toast(`🎧 ${inP.name} is IN for ${outP.name}! Points split at ${fmtPts(outSnap)}.`);
}

// ---------- MATCHUP tab ----------
function scheduledMatchup(teamId, week) {
  return matchupsAll.find((m) => m.week === week
    && (m.home_team_id === teamId || m.away_team_id === teamId));
}

async function renderMatchupTab() {
  const el = $('matchup-view');
  if (league.status !== 'active' && league.status !== 'complete') {
    el.innerHTML = '<div class="panel"><p class="empty-note">Matchups appear once the draft is done and the schedule is set.</p></div>';
    return;
  }
  el.innerHTML = '<div class="panel"><p class="empty-note">Loading matchup…</p></div>';
  if (!ownersCache) await loadOwners();
  await fetchWeekEvents(selectedWeek);
  if (!statsByWeek[selectedWeek]) await loadStats(selectedWeek);
  syncStats(selectedWeek);
  if (!lineupsByWeek[selectedWeek]) await loadLineups(selectedWeek);

  const reg = regularWeeks(league);
  let pairs = [];
  let title = `Week ${selectedWeek} Matchups`;
  if (selectedWeek <= reg) {
    pairs = matchupsAll.filter((m) => m.week === selectedWeek)
      .map((m) => [m.home_team_id, m.away_team_id]);
  } else {
    const bracket = await computeBracket();
    const round = bracket.rounds.find((r) => r.week === selectedWeek);
    pairs = (round?.games || []).filter((g) => g.a && g.b).map((g) => [g.a.team.id, g.b.team.id]);
    title = `🏆 ${round?.name || 'Playoffs'} — Week ${selectedWeek}`;
  }

  const mine = myTeam();
  const myPair = pairs.find(([a, b]) => a === mine.id || b === mine.id);
  const otherPairs = pairs.filter((p) => p !== myPair);

  const featured = myPair ? renderFeaturedMatchup(myPair, selectedWeek)
    : `<div class="panel"><p class="empty-note">${selectedWeek > reg ? 'You\'re not in this playoff round.' : 'No matchup for your team this week.'}</p></div>`;

  el.innerHTML = `${featured}
    ${otherPairs.length ? `<div class="panel" style="margin-top:16px"><h3>${esc(title)}</h3>
      <div class="mu-list">${otherPairs.map(([a, b]) => {
        const ta = teams.find((t) => t.id === a), tb = teams.find((t) => t.id === b);
        return `<div class="mini-mu"><span>${esc(ta?.name)}</span>
          <span class="sc">${fmtPts(teamWeekScore(a, selectedWeek))} — ${fmtPts(teamWeekScore(b, selectedWeek))}</span>
          <span>${esc(tb?.name)}</span></div>`;
      }).join('')}</div></div>` : ''}`;
}

function renderFeaturedMatchup([aId, bId], week) {
  const mine = myTeam();
  if (bId === mine.id) [aId, bId] = [bId, aId];
  const ta = teams.find((t) => t.id === aId), tb = teams.find((t) => t.id === bId);
  const sa = teamWeekScore(aId, week), sc = teamWeekScore(bId, week);
  const rows = leagueSlots(league).map((slot) => {
    const A = slotScore(aId, week, slot), B = slotScore(bId, week, slot);
    const side = (r, right) => {
      const p = r.playerId && nflPlayers.get(r.playerId);
      return `<div class="mu-side ${right ? 'right' : ''}">
        <img class="headshot" src="${esc(p?.headshot || '')}" alt="" onerror="this.style.visibility='hidden'"/>
        <div class="p-info">
          <div class="p-name" ${p ? `onclick="openProfile('${p.id}')"` : ''}>${r.swap ? '🎧 ' : ''}${esc(p?.name || '—')}</div>
          <div class="p-meta">${p ? gameMetaHtml(p, week) : ''}</div>
        </div>
        <div class="p-pts">${fmtPts(r.pts)}</div></div>`;
    };
    return `<div class="mu-row">${side(A, false)}<span class="slot-tag">${slotLabel(slot, league)}</span>${side(B, true)}</div>`;
  }).join('');
  return `<div class="panel">
    <div class="mu-head">
      <div><div class="mu-team-name">${esc(ta?.name)}</div><div class="mu-owner">you</div><div class="mu-score">${fmtPts(sa)}</div></div>
      <div class="mu-vs">VS</div>
      <div><div class="mu-team-name">${esc(tb?.name)}</div><div class="mu-owner">${esc(ownerName(tb))}</div><div class="mu-score">${fmtPts(sc)}</div></div>
    </div>
    ${rows}</div>`;
}

let ownersCache = null;
function ownerName(team) {
  if (!team) return '';
  const o = ownersCache?.find((p) => p.id === team.owner_id);
  return o ? o.name : '';
}
async function loadOwners() {
  const ids = teams.map((t) => t.owner_id);
  const { data } = await sb.from('ff_players').select('id, name, username').in('id', ids);
  ownersCache = data || [];
}

// ---------- PLAYERS tab ----------
let poolPos = 'ALL';
function setPoolPos(p) { poolPos = p; renderPlayersTab(); }

async function renderPlayersTabAsync() {
  await fetchWeekEvents(selectedWeek);
  if (!statsByWeek[selectedWeek]) await loadStats(selectedWeek);
  if (!lineupsByWeek[selectedWeek]) await loadLineups(selectedWeek);
  $('pos-filters').innerHTML = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'].map((p) =>
    `<button class="pos-filter ${poolPos === p ? 'active' : ''}" onclick="setPoolPos('${p}')">${p}</button>`).join('');
  renderPlayersTab();
}

function renderPlayersTab() {
  const q = ($('pool-search').value || '').trim().toLowerCase();
  const ownedBy = new Map(rosters.map((r) => [r.nfl_player_id, r.team_id]));
  const canManage = league.status === 'active' && myTeam();
  const myCount = myTeam() ? rosters.filter((r) => r.team_id === myTeam().id).length : 0;
  let list = [...nflPlayers.values()]
    .filter((p) => poolPos === 'ALL' || p.position === poolPos)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.team || '').toLowerCase().includes(q));
  list.sort((a, b) => {
    const pa = playerPts(a.id, selectedWeek), pb = playerPts(b.id, selectedWeek);
    if (pa !== pb) return pb - pa;
    return (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9) || a.name.localeCompare(b.name);
  });
  list = list.slice(0, 150);
  $('players-pool').innerHTML = list.map((p) => {
    const ownerTeamId = ownedBy.get(p.id);
    const ownerTeam = ownerTeamId && teams.find((t) => t.id === ownerTeamId);
    const isMinePlayer = ownerTeamId && ownerTeamId === myTeam()?.id;
    let action = '';
    if (canManage) {
      if (!ownerTeamId) action = `<button class="btn-small" onclick="addPlayer('${p.id}')">＋ Add</button>`;
      else if (isMinePlayer) action = `<button class="btn-small red" onclick="dropPlayer('${p.id}')">Drop</button>`;
    }
    return `<div class="pool-row">
      <span class="pos-badge pos-${p.position}">${p.position}</span>
      <img class="headshot" src="${esc(p.headshot || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
      <div class="p-info">
        <div class="p-name" onclick="openProfile('${p.id}')">${esc(p.name)}</div>
        <div class="p-meta">${p.team ? `${teamFull(p.team)}` : 'Free Agent'} · ${gameMetaHtml(p, selectedWeek)}${statLine(p.id, selectedWeek) ? ` · ${esc(statLine(p.id, selectedWeek))}` : ''}</div>
      </div>
      <span class="owner-tag ${ownerTeamId ? '' : 'fa'}">${ownerTeam ? esc(ownerTeam.name) : 'FA'}</span>
      <div class="p-pts">${fmtPts(playerPts(p.id, selectedWeek))}</div>
      ${action}</div>`;
  }).join('') || '<p class="empty-note">No players match. Try another search.</p>';
  if (canManage) {
    $('players-pool').insertAdjacentHTML('afterbegin',
      `<p class="table-note">Your roster: ${myCount}/${rosterSize(league)}. Adding when full asks you to drop someone.</p>`);
  }
}

async function addPlayer(pid, dropPid = null) {
  const mine = myTeam();
  const myRoster = rosters.filter((r) => r.team_id === mine.id);
  if (!dropPid && myRoster.length >= rosterSize(league)) {
    const droppable = myRoster.map((r) => nflPlayers.get(r.nfl_player_id)).filter(Boolean)
      .filter((p) => canDrop(p.id));
    openModal(`
      <div class="modal-head"><h3>Roster full — drop who?</h3>
        <button class="modal-close" onclick="closeModal()">✕</button></div>
      <p class="panel-sub">Adding <b>${esc(nflPlayers.get(pid)?.name)}</b> — pick a player to drop:</p>
      <div class="pick-list">${droppable.map((p) => `
        <div class="slot-row" onclick="addPlayer('${pid}','${p.id}')">
          <img class="headshot" src="${esc(p.headshot || '')}" alt="" onerror="this.style.visibility='hidden'"/>
          <div class="p-info"><div class="p-name">${esc(p.name)} <span class="pos-badge pos-${p.position}">${p.position}</span></div></div>
        </div>`).join('') || '<p class="empty-note">Nobody droppable right now (locked starters can\'t be dropped).</p>'}</div>`);
    return;
  }
  if (dropPid) {
    const ok = await doDrop(dropPid, true);
    if (!ok) return;
  }
  const { error } = await sb.from('ff_rosters')
    .insert({ league_id: league.id, team_id: mine.id, nfl_player_id: pid });
  if (error) return toast(error.code === '23505' ? 'Someone beat you to it — player already taken!' : error.message, true);
  await loadLeague(league.id);
  closeModal();
  renderTab();
  toast(`Added ${nflPlayers.get(pid)?.name} ✓`);
}

function canDrop(pid) {
  const mine = myTeam();
  const week = currentNflWeek;
  const inLineup = (lineupsByWeek[week] || []).some((l) => l.team_id === mine.id && l.nfl_player_id === pid);
  const inSwap = teamSwaps(mine.id, week).some((s) => s.in_player_id === pid || s.out_player_id === pid);
  if (inSwap) return false;
  if (inLineup && playerLocked(pid, week)) return false;
  return true;
}

async function dropPlayer(pid) {
  if (!canDrop(pid)) return toast('That player is locked in this week\'s lineup — drop him after the week.', true);
  if (!confirm(`Drop ${nflPlayers.get(pid)?.name} to free agency?`)) return;
  const ok = await doDrop(pid);
  if (ok) { await loadLeague(league.id); renderTab(); toast('Dropped ✓'); }
}

async function doDrop(pid, silent = false) {
  const mine = myTeam();
  const { error } = await sb.from('ff_rosters').delete()
    .eq('league_id', league.id).eq('team_id', mine.id).eq('nfl_player_id', pid);
  if (error) { toast(error.message, true); return false; }
  // clear him out of current & future lineups
  await sb.from('ff_lineups').delete()
    .eq('league_id', league.id).eq('team_id', mine.id).eq('nfl_player_id', pid)
    .gte('week', currentNflWeek);
  Object.keys(lineupsByWeek).forEach((w) => {
    if (Number(w) >= currentNflWeek) {
      lineupsByWeek[w] = lineupsByWeek[w].filter((l) => !(l.team_id === mine.id && l.nfl_player_id === pid));
    }
  });
  return true;
}

// ---------- STANDINGS tab ----------
async function loadSeasonData() {
  const reg = regularWeeks(league);
  const upto = Math.min(currentNflWeek, FANTASY_WEEKS);
  const weeks = Array.from({ length: upto }, (_, i) => i + 1);
  await Promise.all(weeks.map((w) => fetchWeekEvents(w)));
  const needStats = weeks.filter((w) => !statsByWeek[w]);
  await Promise.all(needStats.map((w) => loadStats(w)));
  const needLineups = weeks.filter((w) => !lineupsByWeek[w]);
  await Promise.all(needLineups.map((w) => loadLineups(w)));
  return { reg, upto, weeks };
}

function unsyncedCompleteWeeks(weeks) {
  return weeks.filter((w) => weekComplete(w) && (statsByWeek[w]?.size || 0) === 0);
}

async function syncPastWeeks() {
  const { weeks } = await loadSeasonData();
  const missing = unsyncedCompleteWeeks(weeks);
  toast(`Syncing ${missing.length} week(s) of box scores…`);
  for (const w of missing) await syncStats(w, true);
  renderTab();
  toast('Season stats synced ✓');
}

function computeStandings(reg) {
  const recs = new Map(teams.map((t) => [t.id, { team: t, w: 0, l: 0, t: 0, pf: 0, pa: 0 }]));
  for (let w = 1; w <= reg; w++) {
    if (!weekComplete(w) || (statsByWeek[w]?.size || 0) === 0) continue;
    for (const m of matchupsAll.filter((x) => x.week === w)) {
      const hs = teamWeekScore(m.home_team_id, w);
      const as = teamWeekScore(m.away_team_id, w);
      const H = recs.get(m.home_team_id), A = recs.get(m.away_team_id);
      if (!H || !A) continue;
      H.pf += hs; H.pa += as; A.pf += as; A.pa += hs;
      if (hs > as) { H.w++; A.l++; } else if (as > hs) { A.w++; H.l++; } else { H.t++; A.t++; }
    }
  }
  const sorted = [...recs.values()].sort((a, b) =>
    (b.w - b.l) - (a.w - a.l) || b.pf - a.pf || a.team.name.localeCompare(b.team.name));
  return sorted;
}

function playoffSeeds(reg) {
  const sorted = computeStandings(reg);
  const byDiv = new Map();
  for (const r of sorted) {
    const d = r.team.division || 1;
    if (!byDiv.has(d)) byDiv.set(d, []);
    byDiv.get(d).push(r);
  }
  const divWinners = [...byDiv.values()].map((rs) => rs[0]);
  divWinners.sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.pf - a.pf);
  const winnersSet = new Set(divWinners.map((r) => r.team.id));
  const wildcards = sorted.filter((r) => !winnersSet.has(r.team.id));
  return [...divWinners, ...wildcards].slice(0, league.playoff_teams)
    .map((r, i) => ({ seed: i + 1, team: r.team, rec: r }));
}

async function computeBracket() {
  const { reg } = await loadSeasonData();
  const regDone = Array.from({ length: reg }, (_, i) => i + 1)
    .every((w) => weekComplete(w) && (statsByWeek[w]?.size || 0) > 0);
  const seeds = playoffSeeds(reg);
  const rounds = [];
  const winnerOf = (game, week) => {
    if (!game.a || !game.b) return game.a || game.b || null;
    if (!weekComplete(week)) return null;
    const sa = teamWeekScore(game.a.team.id, week), sc = teamWeekScore(game.b.team.id, week);
    if (sa === sc) return game.a.seed < game.b.seed ? game.a : game.b; // higher seed advances ties
    return sa > sc ? game.a : game.b;
  };
  const S = (n) => (regDone && seeds[n - 1]) || null;
  if (league.playoff_teams === 6) {
    const qfWeek = reg + 1, sfWeek = reg + 2, fWeek = reg + 3;
    const qf = { week: qfWeek, name: 'Quarterfinals', games: [
      { a: S(3), b: S(6) }, { a: S(4), b: S(5) },
    ] };
    qf.games.forEach((g) => { g.winner = winnerOf(g, qfWeek); });
    const qfWinners = qf.games.map((g) => g.winner).filter(Boolean)
      .sort((a, b) => a.seed - b.seed);
    const sf = { week: sfWeek, name: 'Semifinals', games: [
      { a: S(1), b: qfWinners[1] || null },
      { a: S(2), b: qfWinners[0] || null },
    ] };
    sf.games.forEach((g) => { g.winner = (g.a && g.b) ? winnerOf(g, sfWeek) : null; });
    const fin = { week: fWeek, name: '🏆 Championship', games: [
      { a: sf.games[0].winner, b: sf.games[1].winner },
    ] };
    fin.games.forEach((g) => { g.winner = (g.a && g.b) ? winnerOf(g, fWeek) : null; });
    rounds.push(qf, sf, fin);
  } else {
    const sfWeek = reg + 1, fWeek = reg + 2;
    const sf = { week: sfWeek, name: 'Semifinals', games: [
      { a: S(1), b: S(4) }, { a: S(2), b: S(3) },
    ] };
    sf.games.forEach((g) => { g.winner = (g.a && g.b) ? winnerOf(g, sfWeek) : null; });
    const fin = { week: fWeek, name: '🏆 Championship', games: [
      { a: sf.games[0].winner, b: sf.games[1].winner },
    ] };
    fin.games.forEach((g) => { g.winner = (g.a && g.b) ? winnerOf(g, fWeek) : null; });
    rounds.push(sf, fin);
  }
  const champ = rounds[rounds.length - 1].games[0].winner || null;
  return { seeds, rounds, regDone, champ };
}

async function renderStandingsTab() {
  const el = $('standings-view');
  if (league.status === 'pre_draft' || league.status === 'drafting') {
    el.innerHTML = '<div class="panel"><p class="empty-note">Standings appear once the season starts.</p></div>';
    return;
  }
  el.innerHTML = '<div class="panel"><p class="empty-note">Crunching the numbers…</p></div>';
  const { reg, weeks } = await loadSeasonData();
  if (!ownersCache) await loadOwners();
  const missing = unsyncedCompleteWeeks(weeks.filter((w) => w <= reg));
  const sorted = computeStandings(reg);
  const bracket = await computeBracket();

  const divBlocks = [];
  const nd = league.num_divisions;
  for (let d = 1; d <= nd; d++) {
    const rows = sorted.filter((r) => (r.team.division || 1) === d);
    if (!rows.length) continue;
    divBlocks.push(`<div class="division-block">
      ${nd > 1 ? `<h3>Division ${d}</h3>` : ''}
      <table><thead><tr><th class="rank">#</th><th>Team</th><th>Owner</th>
        <th class="num">W</th><th class="num">L</th><th class="num">T</th>
        <th class="num">PF</th><th class="num">PA</th></tr></thead>
      <tbody>${rows.map((r, i) => `
        <tr class="${r.team.owner_id === me.id ? 'me' : ''}">
          <td class="rank">${i + 1}</td>
          <td><b>${esc(r.team.name)}</b></td>
          <td>${esc(ownerName(r.team))}</td>
          <td class="num">${r.w}</td><td class="num">${r.l}</td><td class="num">${r.t}</td>
          <td class="num">${fmtPts(r.pf)}</td><td class="num">${fmtPts(r.pa)}</td>
        </tr>`).join('')}</tbody></table></div>`);
  }

  const bracketHtml = `<div class="panel" style="margin-top:16px">
    <h2>🏆 Playoff Picture</h2>
    <p class="panel-sub">Regular season: weeks 1–${reg}. ${league.playoff_teams} teams make it —
      division winners first, then wildcards by record &amp; points.
      ${bracket.regDone ? '' : 'Seeds below are the current projection.'}</p>
    ${bracket.champ ? `<div class="champ-banner">👑 <b>${esc(bracket.champ.team.name)}</b> (${esc(ownerName(bracket.champ.team))}) is your league champion!</div>` : ''}
    <div class="bracket">
      ${bracket.rounds.map((r) => `<div class="bracket-round">
        <h4>${esc(r.name)} — Week ${r.week}</h4>
        ${r.games.map((g) => {
          const row = (side) => {
            if (!side) return '<div class="bg-row"><span class="seed">—</span><span>TBD</span></div>';
            const pts = weekComplete(r.week) || (eventsByWeek[r.week] || []).some((e) => e.state !== 'pre')
              ? fmtPts(teamWeekScore(side.team.id, r.week)) : '';
            return `<div class="bg-row ${g.winner === side ? 'winner' : ''}">
              <span><span class="seed">#${side.seed}</span>${esc(side.team.name)}</span><span>${pts}</span></div>`;
          };
          return `<div class="bracket-game">${row(g.a)}${g.a && !g.b && r.name === 'Semifinals' ? '<div class="bg-row"><span class="seed">→</span><span>awaits QF winner</span></div>' : row(g.b)}</div>`;
        }).join('')}
      </div>`).join('')}
    </div></div>`;

  el.innerHTML = `<div class="panel">
    <div class="standings-head"><h2>📊 Standings</h2>
      <span class="standings-status">${missing.length
        ? `<button class="btn-small gold" onclick="syncPastWeeks()">Sync ${missing.length} completed week(s)</button>`
        : `Through completed weeks · Week ${currentNflWeek} is ${weekComplete(currentNflWeek) ? 'final' : 'in progress'}`}</span></div>
    ${divBlocks.join('')}
  </div>${bracketHtml}`;
}

// ---------- DRAFT tab ----------
function startDraftPoll() {
  clearInterval(draftPollTimer);
  draftPollTimer = setInterval(async () => {
    if (document.hidden || !league || league.status !== 'drafting') return;
    const before = draftPicks.length;
    const [{ data: lg }, { data: dp }] = await Promise.all([
      sb.from('ff_leagues').select('*').eq('id', league.id).single(),
      sb.from('ff_draft_picks').select('*').eq('league_id', league.id).order('overall'),
    ]);
    league = lg; draftPicks = dp || [];
    if (league.status !== 'drafting') {
      clearInterval(draftPollTimer);
      await loadLeague(league.id);
      showTab('team');
      toast('Draft complete — your season is live! 🏈');
      return;
    }
    // If the last picker's client dropped before finalizing, anyone finishes the job
    if (draftPicks.length >= teams.length * draftRounds()) { await finalizeDraft(); return; }
    if (draftPicks.length !== before) renderDraftTab();
  }, 3000);
}

const draftOrder = () => [...teams].sort((a, b) => (a.draft_pos || 99) - (b.draft_pos || 99));
const draftRounds = () => rosterSize(league);

function onClockTeam() {
  const order = draftOrder();
  const n = order.length;
  const overall = draftPicks.length + 1;
  if (overall > n * draftRounds()) return null;
  const round = Math.floor((overall - 1) / n);
  const idx = (overall - 1) % n;
  return order[round % 2 === 0 ? idx : n - 1 - idx];
}

function renderDraftTab() {
  const el = $('draft-view');
  if (!ownersCache) { loadOwners().then(renderDraftTab); }
  const inviteUrl = `${location.origin}${location.pathname}?join=${league.invite_code}`;

  if (league.status === 'pre_draft') {
    const full = teams.length >= league.num_teams;
    const draftDate = league.draft_at ? new Date(league.draft_at) : null;
    el.innerHTML = `<div class="panel">
      <h2>🗓️ Draft Central — ${esc(league.name)}</h2>
      <p class="panel-sub">${league.num_teams} teams · ${league.num_divisions > 1 ? `${league.num_divisions} divisions · ` : ''}${league.playoff_teams}-team playoffs · regular season weeks 1–${regularWeeks(league)}, playoffs through week ${FANTASY_WEEKS} (Week 18 doesn't count — nobody plays their starters).</p>
      <div class="invite-box">
        <span>Invite your friends:</span>
        <span class="invite-code">${league.invite_code}</span>
        <button class="btn-small" onclick="copyInvite('${inviteUrl}')">📋 Copy invite link</button>
      </div>
      <p><b>Draft:</b> ${draftDate ? draftDate.toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not scheduled'}
        ${isCommish() ? `<button class="btn-ghost" style="margin-left:8px" onclick="changeDraftDate()">Change</button>` : ''}</p>
      ${leagueRulesHtml(league)}
      <h3 style="margin-top:16px">Teams (${teams.length}/${league.num_teams})</h3>
      <table><thead><tr><th>Team</th><th>Owner</th></tr></thead><tbody>
        ${teams.map((t) => `<tr class="${t.owner_id === me.id ? 'me' : ''}">
          <td><b>${esc(t.name)}</b>${t.owner_id === league.commissioner_id ? ' <span title="Commissioner">Ⓒ</span>' : ''}</td>
          <td>${esc(ownerName(t))}</td></tr>`).join('')}
      </tbody></table>
      ${isCommish() ? `
        <button class="btn-primary" ${full ? '' : 'disabled'} onclick="startDraft()">
          🚀 Start the Draft ${full ? '' : `(need ${league.num_teams - teams.length} more team${league.num_teams - teams.length > 1 ? 's' : ''})`}</button>
        <p class="form-note">Starting the draft randomizes the snake order and assigns divisions. ${draftRounds()} rounds — ${starterCount(league)} starters + ${Number(leagueRoster(league).BN) || 0} bench.</p>`
        : `<p class="form-note">Waiting on the commissioner to start the draft${full ? '' : ' once the league fills up'}.</p>`}
    </div>`;
    return;
  }

  if (league.status === 'drafting') {
    const order = draftOrder();
    const clock = onClockTeam();
    const myTurn = clock && clock.owner_id === me.id;
    const overall = draftPicks.length + 1;
    const round = Math.floor((overall - 1) / order.length) + 1;
    el.innerHTML = `
      <div class="on-clock ${myTurn ? 'my-turn' : ''}">
        <div><div class="oc-label">Round ${round} · Pick ${overall} of ${order.length * draftRounds()}</div>
          <div class="oc-team">${myTurn ? '🎉 YOU\'RE ON THE CLOCK!' : `On the clock: ${esc(clock?.name || '…')} (${esc(ownerName(clock))})`}</div></div>
        <div class="oc-label">Snake order: ${order.map((t) => esc(t.name.split(' ')[0])).join(' → ')}</div>
      </div>
      <div class="draft-grid">
        <div class="panel">
          <h3>Player Pool</h3>
          <div class="pool-controls">
            <input type="text" id="draft-search" placeholder="🔍 Search…" value="${esc(window._draftQ || '')}"
              oninput="window._draftQ=this.value;renderDraftPool()" />
            <div class="pos-filters">${['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'].map((p) =>
              `<button class="pos-filter ${(window._draftPos || 'ALL') === p ? 'active' : ''}"
                onclick="window._draftPos='${p}';renderDraftTab()">${p}</button>`).join('')}</div>
          </div>
          <div id="draft-pool-list"></div>
        </div>
        <div class="panel">
          <h3>Draft Board</h3>
          ${[...draftPicks].reverse().slice(0, 40).map((pk) => {
            const p = nflPlayers.get(pk.nfl_player_id);
            const t = teams.find((x) => x.id === pk.team_id);
            return `<div class="draft-pick-row"><span class="pk">${pk.overall}.</span>
              <span class="pos-badge pos-${p?.position}">${p?.position || '?'}</span>
              <span style="flex:1"><b>${esc(p?.name || '?')}</b></span>
              <span class="owner-tag">${esc(t?.name || '')}</span></div>`;
          }).join('') || '<p class="empty-note">No picks yet — the board fills in live.</p>'}
        </div>
      </div>`;
    renderDraftPool();
    return;
  }

  // active / complete: recap
  el.innerHTML = `<div class="panel">
    <h2>📋 Draft Recap</h2>
    <div class="invite-box"><span>Invite code:</span><span class="invite-code">${league.invite_code}</span></div>
    ${leagueRulesHtml(league)}
    ${draftPicks.length ? `<table><thead><tr><th>Pick</th><th>Player</th><th>Pos</th><th>Team</th></tr></thead>
      <tbody>${draftPicks.map((pk) => {
        const p = nflPlayers.get(pk.nfl_player_id);
        const t = teams.find((x) => x.id === pk.team_id);
        return `<tr><td class="rank">${pk.overall}</td><td><b>${esc(p?.name || '?')}</b></td>
          <td>${p?.position || ''}</td><td>${esc(t?.name || '')}</td></tr>`;
      }).join('')}</tbody></table>` : '<p class="empty-note">No draft data.</p>'}
  </div>`;
}

function renderDraftPool() {
  const box = $('draft-pool-list');
  if (!box) return;
  const clock = onClockTeam();
  const myTurn = clock && clock.owner_id === me.id;
  const drafted = new Set(draftPicks.map((p) => p.nfl_player_id));
  const q = (window._draftQ || '').toLowerCase();
  let pool = [...nflPlayers.values()].filter((p) => !drafted.has(p.id))
    .filter((p) => (window._draftPos || 'ALL') === 'ALL' || p.position === window._draftPos)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.team || '').toLowerCase().includes(q));
  pool.sort((a, b) => (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9) || a.name.localeCompare(b.name));
  pool = pool.slice(0, 100);
  box.innerHTML = pool.map((p) => `<div class="pool-row">
      <span class="pos-badge pos-${p.position}">${p.position}</span>
      <img class="headshot" src="${esc(p.headshot || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
      <div class="p-info">
        <div class="p-name" onclick="openProfile('${p.id}')">${esc(p.name)}</div>
        <div class="p-meta">${teamFull(p.team)}</div>
      </div>
      <button class="btn-small" ${myTurn ? '' : 'disabled'} onclick="draftPlayer('${p.id}')">Draft</button>
    </div>`).join('') || '<p class="empty-note">No players match.</p>';
}

function copyInvite(url) {
  navigator.clipboard?.writeText(url)
    .then(() => toast('Invite link copied — send it to your friends! 📨'))
    .catch(() => prompt('Copy this invite link:', url));
}

async function changeDraftDate() {
  const cur = league.draft_at ? new Date(league.draft_at) : new Date();
  const val = prompt('New draft date & time (YYYY-MM-DD HH:MM):',
    `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')} ${String(cur.getHours()).padStart(2, '0')}:${String(cur.getMinutes()).padStart(2, '0')}`);
  if (!val) return;
  const d = new Date(val.replace(' ', 'T'));
  if (isNaN(d)) return toast('Couldn\'t read that date — use YYYY-MM-DD HH:MM.', true);
  const { error } = await sb.from('ff_leagues').update({ draft_at: d.toISOString() }).eq('id', league.id);
  if (error) return toast(error.message, true);
  league.draft_at = d.toISOString();
  renderDraftTab();
  toast('Draft rescheduled ✓');
}

async function startDraft() {
  if (!isCommish() || teams.length < league.num_teams) return;
  if (!confirm(`Start the draft?\n\nThis randomizes the snake order and assigns divisions. All ${league.num_teams} owners should be here!`)) return;
  const shuffled = [...teams].sort(() => Math.random() - 0.5);
  for (let i = 0; i < shuffled.length; i++) {
    await sb.from('ff_teams').update({
      draft_pos: i + 1,
      division: (i % league.num_divisions) + 1,
    }).eq('id', shuffled[i].id);
  }
  const { error } = await sb.from('ff_leagues').update({ status: 'drafting' })
    .eq('id', league.id).eq('status', 'pre_draft');
  if (error) return toast(error.message, true);
  await loadLeague(league.id);
  showTab('draft');
  toast('The draft is LIVE! 🚀');
}

async function draftPlayer(pid) {
  const clock = onClockTeam();
  if (!clock || clock.owner_id !== me.id) return toast('Not your pick!', true);
  const overall = draftPicks.length + 1;
  const { data, error } = await sb.from('ff_draft_picks').insert({
    league_id: league.id, overall, team_id: clock.id, nfl_player_id: pid,
  }).select().single();
  if (error) {
    if (error.code === '23505') {
      toast('Pick collision — refreshing the board…', true);
      const { data: dp } = await sb.from('ff_draft_picks').select('*').eq('league_id', league.id).order('overall');
      draftPicks = dp || [];
      renderDraftTab();
      return;
    }
    return toast(error.message, true);
  }
  draftPicks.push(data);
  toast(`Pick ${overall}: ${nflPlayers.get(pid)?.name} ✓`);
  if (draftPicks.length >= teams.length * draftRounds()) await finalizeDraft();
  renderDraftTab();
}

async function finalizeDraft() {
  await generateSchedule();
  await sb.from('ff_leagues').update({ status: 'active' })
    .eq('id', league.id).eq('status', 'drafting');
  await loadLeague(league.id);
  showTab('team');
  toast('Draft complete — schedule generated. Good luck this season! 🏈');
}

// Deterministic round-robin (circle method) so any client generates the
// exact same schedule; duplicate inserts are ignored.
async function generateSchedule() {
  const order = draftOrder().map((t) => t.id);
  const n = order.length;
  const reg = regularWeeks(league);
  const rows = [];
  for (let w = 1; w <= reg; w++) {
    const r = (w - 1) % (n - 1);
    const rest = order.slice(1);
    const rotated = rest.slice(r).concat(rest.slice(0, r));
    const list = [order[0], ...rotated];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      const home = w % 2 === 1 ? a : b;
      const away = w % 2 === 1 ? b : a;
      rows.push({ league_id: league.id, week: w, home_team_id: home, away_team_id: away });
    }
  }
  const { error } = await sb.from('ff_matchups')
    .upsert(rows, { onConflict: 'league_id,week,home_team_id', ignoreDuplicates: true });
  if (error) console.warn('schedule generation:', error);
}

// ---------- player profile (last season + weekly stats) ----------
async function openProfile(pid) {
  const p = nflPlayers.get(pid);
  if (!p) return;
  openModal(`
    <div class="modal-head">
      <div class="profile-head">
        <img class="headshot" src="${esc(p.headshot || '')}" alt="" onerror="this.style.visibility='hidden'"/>
        <div>
          <div class="ph-name">${esc(p.name)}</div>
          <div class="ph-meta">${p.position} · ${teamFull(p.team)}${p.jersey ? ` · #${esc(p.jersey)}` : ''}</div>
        </div>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div id="profile-body"><p class="empty-note">Loading stats…</p></div>`);

  if (pid.startsWith('DST-')) {
    $('profile-body').innerHTML = renderDstProfile(p);
    return;
  }
  const [thisYear, lastYear] = await Promise.all([
    fetchGamelog(pid, SEASON), fetchGamelog(pid, LAST_SEASON),
  ]);
  const cur = statRow(pid, selectedWeek);
  $('profile-body').innerHTML = `
    ${cur ? `<h3>Week ${selectedWeek} — ${fmtPts(playerPts(pid, selectedWeek))} fantasy pts</h3>
      <p class="panel-sub">${esc(statLine(pid, selectedWeek)) || 'No stats yet'} ${cur.game_status === 'in_progress' ? '<span class="live-badge">● LIVE</span>' : ''}</p>` : ''}
    <h3>${SEASON} Weekly Stats</h3>
    ${renderGamelogTable(thisYear) || '<p class="empty-note">No games yet this season.</p>'}
    <h3 style="margin-top:16px">${LAST_SEASON} Season</h3>
    ${renderGamelogTable(lastYear) || '<p class="empty-note">No stats found for last season.</p>'}`;
}

function renderDstProfile(p) {
  const rows = [];
  for (let w = 1; w <= FANTASY_WEEKS; w++) {
    const r = (statsByWeek[w] || new Map()).get(p.id);
    if (r) rows.push({ w, r });
  }
  if (!rows.length) return '<p class="empty-note">Defense/special teams stats appear as games are played and synced.</p>';
  return `<div class="stat-scroll"><table>
    <thead><tr><th>Wk</th><th>Opp</th><th class="num">Sacks</th><th class="num">INT</th>
      <th class="num">Fum Rec</th><th class="num">TD</th><th class="num">Pts Allowed</th><th class="num">Fantasy</th></tr></thead>
    <tbody>${rows.map(({ w, r }) => `<tr><td>${w}</td><td>${esc(r.opponent || '')}</td>
      <td class="num">${r.stats.sacks || 0}</td><td class="num">${r.stats.ints || 0}</td>
      <td class="num">${r.stats.fumRec || 0}</td><td class="num">${r.stats.tds || 0}</td>
      <td class="num">${r.stats.pointsAllowed ?? '—'}</td><td class="num"><b>${fmtPts(scoreStatsWith(r.stats || {}, true, leagueScoring(league)))}</b></td></tr>`).join('')}
    </tbody></table></div>`;
}

async function fetchGamelog(pid, season) {
  try {
    const res = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${pid}/gamelog?season=${season}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function renderGamelogTable(gl) {
  if (!gl || !gl.labels || !gl.seasonTypes?.length) return '';
  const regular = gl.seasonTypes.find((s) => /regular/i.test(s.displayName)) || gl.seasonTypes[0];
  const eventRows = [];
  for (const cat of regular.categories || []) {
    for (const e of cat.events || []) {
      const meta = gl.events?.[e.eventId];
      eventRows.push({ meta, stats: e.stats });
    }
  }
  if (!eventRows.length) return '';
  eventRows.sort((a, b) => (a.meta?.week || 0) - (b.meta?.week || 0));
  const totals = gl.labels.map((_, i) => eventRows.reduce((s, r) => {
    const v = parseFloat(r.stats[i]);
    return isNaN(v) ? s : s + v;
  }, 0));
  return `<div class="stat-scroll"><table>
    <thead><tr><th>Wk</th><th>Opp</th><th>Result</th>${gl.labels.map((l) => `<th class="num">${esc(l)}</th>`).join('')}</tr></thead>
    <tbody>
      ${eventRows.map((r) => `<tr>
        <td>${r.meta?.week ?? ''}</td>
        <td>${esc(r.meta?.opponent?.abbreviation || '')}</td>
        <td>${esc(r.meta?.gameResult || '')} ${r.meta ? `${r.meta.score || ''}` : ''}</td>
        ${r.stats.map((s) => `<td class="num">${esc(s)}</td>`).join('')}</tr>`).join('')}
      <tr><td colspan="3"><b>Season totals</b></td>
        ${totals.map((t) => `<td class="num"><b>${Math.round(t * 10) / 10}</b></td>`).join('')}</tr>
    </tbody></table></div>`;
}

// ---------- modal & toast ----------
function openModal(html) {
  $('modal-box').innerHTML = html;
  $('modal-backdrop').classList.remove('hidden');
}
function closeModal() { $('modal-backdrop').classList.add('hidden'); }

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

init();
