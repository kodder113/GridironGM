# Gridiron GM — AI Assistant Briefing

This file explains the project to any AI assistant (ChatGPT/Codex, Claude, etc.) working on this repo. Read it fully before changing anything.

## What this is

**Gridiron GM** is a standalone fantasy football web app ("Build. Manage. Dominate."), built for the 2026 NFL season. It works like Yahoo/ESPN/NFL fantasy — leagues, drafts, weekly head-to-head matchups, playoffs, free agency — with one **signature feature that must never be broken**:

### 🎧 Live Coaching (the whole point of the app)
A manager can substitute a starter **mid-game**, like a real coach:
- Allowed only while the starter's real NFL game is **in progress**.
- The sub-in must be a same-slot-eligible bench player whose game is **not final** (can be live or not started). You cannot sit a player without a replacement.
- **One live sub per lineup slot per week. No undo.**

**Scoring — the normalized game-progress boundary model.** The fantasy week is one continuous game; **a lineup slot can never receive more than one normalized game's worth of usable playing time, and no replacement receives retroactive points.** Concretely (all times normalized against the scheduled 60 minutes, `gameBoundaryElapsed()`):
- At the swap, the slot has consumed `boundary` **B** = the out player's normalized elapsed time (halftime Thursday = 0.5; **OT or final = 1.0, slot fully consumed**). The out player keeps only his points at that moment (`out_stats_at_swap`, re-scored under current league rules).
- The replacement earns only production **after his own game's effective boundary E = max(B, his elapsed at swap)** (`in_elapsed_at_swap`). Swapped at 40%? The sub counts only from HIS game's 40:00-equivalent mark — even if he hasn't kicked off yet. His pre-boundary production **never** counts.
- Slot score = `pts(out_stats_at_swap) + (in_current − pts(in_stats_at_boundary))` — see `slotScore()/swapInCredit()/swapOutPts()`. While `boundary_status = 'pending'` (his game hasn't reached E), the sub contributes **zero**.
- **Settlement is automatic** (`maybeSettleSwaps()` on every stats sync), with precision recorded in `boundary_status`: `observed` (a live sync tick at/after E snapshotted his real line — also set instantly at swap time when he was already at/ahead of the boundary), `reconstructed` (**Tier 2**: his game went final and `pbp.js` rebuilt his exact stat line at E from ESPN play-by-play — upgrades observed/estimated), `estimated` (proration by E, only when play-by-play is unavailable or the slot is a DST).
- `pbp.js` (`window.PBP`) is the play-by-play reconstruction library: plays attributed by snap time against the game clock. **Certified against the complete 2025 season** via `probe.html` (dev page, "Probe week range"): 272 games, 5,527 scored player-lines, 100% clock coverage (clocks verified against official linescores), and only 13 residual strict failures (~0.24%) under the zero-tolerance criterion (exact TDs/INTs/receptions/fumbles/kicks per player, ≤2 pts yardage drift, no phantom credits). All 13 residuals are box-vs-text disagreements the play text cannot resolve (fumbles/INTs the text omits or contradicts, mostly on non-rosterable defensive players; the rosterable ones are single ≤2-pt events) — each is contained by the settlement self-check (`reconAgreesWithBox` demotes any disagreeing player-game to flagged estimation). Keep `probe.html` PASSing when touching `pbp.js`; six offline regression suites live in the session history and the boundary invariants run in the Coach Simulator.
- Raw stat lines (not points) are stored so commissioner scoring changes re-score swaps correctly; the old `out/in_points_at_swap` columns remain as display/legacy fallback only.

## Architecture

- **Pure static site, no build step, no server.** `index.html` + `app.js` (~2400 lines, vanilla JS, global functions wired via inline `onclick`) + `styles.css` + `vendor/supabase.js` (vendored supabase-js v2 UMD). Serve with any static server; open in browser.
- **Backend = Supabase Postgres** (project `kixdpoizujvnwsyqgmqe`, URL + publishable key hardcoded at top of `app.js`). No Supabase Auth: sign-in is email-lookup in `ff_players` with the id kept in `localStorage`. RLS is enabled with fully open policies (friends-league trust model). All tables are prefixed `ff_` (the same Supabase project hosts unrelated `wm_*` tables for a different app — never touch those).
- **All game logic runs client-side.** Clients sync external data into shared Supabase tables; every client re-computes scores from raw cached stats. Multi-client races are resolved with unique constraints + retry (e.g. draft pick collisions on `unique(league_id, overall)`).
- **External data (browser-fetched, no keys):**
  - ESPN public APIs: `site.api.espn.com/.../scoreboard` (schedule/live game state, per week), `.../summary?event=` (box scores → per-player stats), `.../teams/{id}/roster` (weekly player-pool refresh + stale-player reconciliation), `site.web.api.espn.com/.../athletes/{id}/gamelog` (profile modal stats).
  - FantasyPros expert consensus ranks via the DynastyProcess GitHub mirror (`raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv`), seeded into `ff_nfl_players.rank/pos_rank/fp_id` (624 ranked players).
- Season constant: `FANTASY_WEEKS = 17` — always the NFL's 18 weeks minus one ("nobody plays their starters in Week 18"). This is a product rule, not an accident.

## Database (all in Supabase, prefix `ff_`)

| Table | Notes |
|---|---|
| `ff_players` | sign-ups: name, unique username, unique email, age_range, favorite_team. CPU bot accounts have username `cpu_*` |
| `ff_leagues` | name, commissioner_id, num_teams (2–16 even), num_divisions, playoff_teams (2/4/6), invite_code, draft_at, status (`pre_draft→drafting→active→complete`), `roster` jsonb, `scoring` jsonb, draft_clock (sec, 0=none), draft_order_mode (`random`/`manual`), draft_started_at |
| `ff_teams` | one per owner per league; division; draft_pos |
| `ff_nfl_players` | shared pool keyed by ESPN athlete id; `DST-<ABBR>` synthetic ids for defenses; rank/pos_rank/fp_id from FantasyPros |
| `ff_draft_picks` | unique (league, overall) and (league, player); DB trigger copies each pick into `ff_rosters` |
| `ff_rosters` | current ownership (draft + add/drop) |
| `ff_lineups` | per team+week+slot; slot keys are `QB1,RB2,FLEX1,...` (position+index, regex-checked) |
| `ff_swaps` | live-coaching subs; **unique (league, team, week, slot)** enforces one sub per position. Boundary model columns: `boundary`, `in_elapsed_at_swap`, `out_stats_at_swap` jsonb, `in_stats_at_boundary` jsonb (null until settled), `boundary_status` (`pending/observed/reconstructed/estimated/legacy`) |
| `ff_matchups` | round-robin regular-season schedule (circle method, generated deterministically at draft end; playoff brackets are *derived*, not stored) |
| `ff_player_week_stats` | shared cache: raw `stats` jsonb + standard-scoring `points`, game status/clock, PK (season, week, player) |

## Commissioner-configurable rules (jsonb on the league)

- `roster`: `{QB,RB,WR,TE,FLEX,K,DST,BN}` counts (0 allowed). Slots, lineups, draft rounds (= roster size), and eligibility all derive from it via `leagueSlots()/slotEligible()/rosterSize()`.
- `scoring`: flat points per counting stat; yardage stats are `{pts, per, whole}` where `whole:false` = fractional (1 per 10 yds → 7 yds = 0.7) and `whole:true` = **completed chunks only** (10 per 10 yds → 7 yds = 0, 27 yds = 20; `Math.trunc`). Implemented in `yardPts()`/`scoreStatsWith()`.
- The shared stats cache stores raw stats + *standard* points; **each league re-scores raw stats with its own rules** (`playerPts()` uses `leagueScoring(league)`).
- Settings modal (⚙️ Rules, commissioner only): scoring + name editable **any time** (retroactive — whole season re-scores; swap stat-line snapshots re-score under the new rules); structure (teams/divisions/playoffs/roster/draft settings) editable **only pre-draft**.

## Draft room

- Auto-starts at `draft_at` once the league is full (any open client claims the start via a guarded status update); commissioner can start manually anytime.
- Order: `random` snake, or `manual` — commissioner assigns pick numbers pre-draft (stored in `ff_teams.draft_pos`).
- Pick clock: deadline = previous pick's `created_at` (or `draft_started_at`) + `draft_clock` seconds. On expiry the **top-ranked available player is auto-picked** — by the on-clock owner's own client, or by the commissioner's client after ~4s grace. Enforcement is client-side (no server): if nobody has the room open, the clock fires when someone loads in.
- Pool sorted by expert rank; rows show overall rank chip, positional rank (e.g. RB3), team, bye week (computed from the full-season schedule, cached in localStorage).
- **Coach's Call**: heuristic recommender (`coachRecommend()`) — expert value + open starting spots + positional drop-off + "you need a K/DST, picks are running out" timing. Renders top pick with reasons + 2 alternates + draft button.
- **CPU teams** (testing/solo play): commissioner can fill open spots with bots (`cpu_*` accounts, 🤖). They autopick by rank & roster need **while the commissioner's draft room is open** (poll-driven). Leagues can be as small as 2 teams; playoff option `2` = championship game only.

## Coach Engine (v1a — live AI coach on top of Live Coaching)

Four layers, all client-side and deterministic (see the `COACH ENGINE v1a` section at the bottom of `app.js`):
1. **Situation model** — `buildSituation(week)`: both lineups with live points, per-slot game state + fraction-of-game-remaining (parsed from ESPN's `"10:38 - 3rd"` detail), rank-derived rest-of-game projections (`BASELINES` table), internal win probability (normal approximation). **User-facing copy uses probability bands only** (Strong Favorite / Favored / Toss-Up / Underdog / Long Shot) — never raw percentages.
2. **Detectors** — `detectSignals()`: SUB (underperforming live starter + eligible better bench; gain priced by boundary-usable time = baseline × min(slot frac remaining, candidate frac remaining)), HOLD (trailing but favored), PROTECT (leading), FIX (empty/bye/free-agent starter pre-kickoff), START (clearly better bench pre-kickoff). Neutral facts only.
3. **Personality policy** — `COACHES` registry: a coach is config (thresholds) + phrase pack, never code. v1a ships `grit` (aggressive: lower sub threshold, speaks earlier) and `analyst` (EV-only, speaks at high confidence). Grit's "gut" is thresholds, NOT randomness — all decisions deterministic and auditable. Coach choice is **per fantasy team** (`ff_teams.coach`), picker in the sideline dock.
4. **Voice + ledger** — template phrase packs per coach (variant chosen by stable hash of the dedupe key; surname interpolated). Every speak-worthy rec is persisted to `ff_coach_recs` (unique `(team_id, week, dedupe_key)` = anti-nagging); accept/reject updates `decision`; `maybeScoreRecs()` scores SUB/HOLD outcomes after the week finals as `(points if followed) − (points if not)`, using the settled boundary-model swap when the sub actually happened, and a boundary-aware counterfactual otherwise (effective boundary from the rec-time `outElapsed/inElapsed` in `situation` jsonb; the in player's pre-boundary share prorated out). Rejected calls are scored too. Record shown in the dock as `W–L · ±pts if followed` with an explicit **beta** label (win > +1.5, loss < −1.5, else push).

**Safety invariants:** the engine never writes `ff_swaps`; "Make the switch" routes into `openLiveSub(slot, recommendedPid)` (coach's pick highlighted) and the existing confirm flow re-validates + re-snapshots. Eligibility comes from `liveSubCandidates()` itself. Draft `coachRecommend()` is policy-parameterized per coach and draft picks log accepted/rejected vs the standing recommendation (`logDraftDecision`). UI: full dock + alerts on Matchup (`#coach-dock`), compact strip on My Team (`#coach-strip`). v1b (not built): The General + Gunslinger, waiver detector, record cards. Do not start v1b/v2 until v1a is field-tested.

## Coach Simulator (developer-only, part of v1a)

`simulator.html` + `sim/` — a test harness that feeds constructed matchup states through the **exact production Coach Engine** (`buildSituation`, `detectSignals`, `COACHES` policies, `runCoachEngine` persistence + dedupe, `speakRec`, and the real `acceptCoachRec` → `openLiveSub` flow). It is NOT a re-implementation. Isolation: `sim/supamock.js` loads *instead of* `vendor/supabase.js`, so every read/write hits in-memory tables (with the `ff_coach_recs` unique-dedupe emulated and column defaults applied) and `window.fetch` is disabled — nothing can reach production Supabase or ESPN. `sim/simulator.js` provides 14 predefined edge-case scenarios (with expected verdicts per coach), a manual situation builder (positions, ranks, points, quarter/clock, bench states pre/live/final/bye/none, swap-used, lead/deficit), Grit-vs-Analyst side-by-side rendering, and a 190+-assertion suite covering the invariants: never an illegal sub, never a finished sub-in, never a second sub on a spent slot, no raw win-probability in any copy (bands only), dedupe on repeat passes, distinct voice per coach for shared verdicts, accepting a rec writes nothing to `ff_swaps`, and the boundary-model block: no retroactive points, pending boundaries contribute zero, effective boundary = max(B, sub elapsed), OT/final consumes the slot at 100%, one normalized game per slot, and SUB gains priced by min(slot remaining, sub remaining). Keep this suite green when touching engine code. The voice layer renders persisted recs through `recDisplayMessage()` so alerts always speak in the *currently selected* coach's phrase pack (the ledger keeps the original message for attribution).

## Season flow

- Lineups lock per-player at their real kickoff; before that, free slot edits. After kickoff → Live Coaching only.
- `teamWeekScore()` sums `slotScore()` over the league's slots; `slotScore` applies the boundary-model swap formula when a swap row exists (pending boundaries contribute zero for the sub).
- Standings count only weeks where all NFL games are final and stats are synced; sort W-L then points-for. Division winners seed first, wildcards by record/PF. Brackets: 6-team (QF wk15, SF wk16, F wk17), 4-team (SF wk16, F wk17), 2-team (F wk17); regular season fills the rest of weeks 1–17.
- Free agency: add/drop with roster-full drop prompt; can't drop a locked starter or swap participant this week.

## Branding

Dark near-black + electric purple + silver ("esports poster" vibe). The hero coach image is `assets/coach.png` (transparent PNG, auto-used by `index.html` with a vector-SVG coach fallback defined inline as `<symbol id="coach">`). The coach also looms behind the live-sub modal (`.coach-loom`) and watermarks the draft room (`#tab-draft::before`). GGM hexagon badge = `<symbol id="ggm-badge">`. Green is reserved for LIVE indicators only.

## Conventions & pitfalls

- `init()` is called at the **end** of `app.js` — top-level `const`s are used inside init-called functions (TDZ), keep it last.
- Reads that can exceed 1000 rows must use the `fetchAll()` pagination helper (PostgREST row cap).
- ESPN team abbreviations are normalized (`WSH→WAS`, `LAR→LA`) via `normAbbr`; `TEAMS` map holds ESPN slugs + numeric ids.
- localStorage caches: events per week (`ff_ev_*`, permanent once final), synced-final flags (`ff_done_*`), byes (`ff_byes_*`), roster-sync timestamp.
- Timers: draft poll (3s), pick clock (500ms), pre-draft countdown (1s), live-stats (75s) — all cleared in `stopTimers()`/`showTab()`.
- The dev environment used to build this had ESPN/Supabase blocked; testing was done with Playwright using faked in-page state. Real network paths run in users' browsers.
- Never rename existing `ff_` columns/tables without a migration; other people's browsers run old code against the same DB during deploys.

## Current status / known gaps

- 2026 season starts Sep 10; live-scoring and Live Coaching paths are untested against real live games until then (pick'em sister app uses the same ESPN endpoints successfully).
- 2-point conversions aren't scored (not in ESPN box scores; would need scoring-play parsing). FG distance bonuses are parsed from scoring-play text and rescale approximately under custom scoring.
- No trades, no waiver priority (first-come free agency), no chat.
- Repo: github.com/kodder113/GridironGM (private). DB migrations were applied directly via Supabase; schema described above is authoritative.
