# Gridiron GM — AI Assistant Briefing

This file explains the project to any AI assistant (ChatGPT/Codex, Claude, etc.) working on this repo. Read it fully before changing anything.

## What this is

**Gridiron GM** is a standalone fantasy football web app ("Build. Manage. Dominate."), built for the 2026 NFL season. It works like Yahoo/ESPN/NFL fantasy — leagues, drafts, weekly head-to-head matchups, playoffs, free agency — with one **signature feature that must never be broken**:

### 🎧 Live Coaching (the whole point of the app)
A manager can substitute a starter **mid-game**, like a real coach:
- Allowed only while the starter's real NFL game is **in progress**.
- The sub-in must be a same-slot-eligible bench player whose game is **not final** (can be live or not started). You cannot sit a player without a replacement.
- **One live sub per lineup slot per week. No undo.**
- Point split: at the moment of the swap, both players' current fantasy points are snapshotted into `ff_swaps` (`out_points_at_swap`, `in_points_at_swap`). The slot then scores:
  `out_points_at_swap + (in_player_current_points − in_points_at_swap)`
  i.e. the benched player keeps only pre-swap points; the sub earns only post-swap points. Snapshots are frozen forever (even if league scoring rules later change).

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
| `ff_swaps` | live-coaching subs; **unique (league, team, week, slot)** enforces one sub per position |
| `ff_matchups` | round-robin regular-season schedule (circle method, generated deterministically at draft end; playoff brackets are *derived*, not stored) |
| `ff_player_week_stats` | shared cache: raw `stats` jsonb + standard-scoring `points`, game status/clock, PK (season, week, player) |

## Commissioner-configurable rules (jsonb on the league)

- `roster`: `{QB,RB,WR,TE,FLEX,K,DST,BN}` counts (0 allowed). Slots, lineups, draft rounds (= roster size), and eligibility all derive from it via `leagueSlots()/slotEligible()/rosterSize()`.
- `scoring`: flat points per counting stat; yardage stats are `{pts, per, whole}` where `whole:false` = fractional (1 per 10 yds → 7 yds = 0.7) and `whole:true` = **completed chunks only** (10 per 10 yds → 7 yds = 0, 27 yds = 20; `Math.trunc`). Implemented in `yardPts()`/`scoreStatsWith()`.
- The shared stats cache stores raw stats + *standard* points; **each league re-scores raw stats with its own rules** (`playerPts()` uses `leagueScoring(league)`).
- Settings modal (⚙️ Rules, commissioner only): scoring + name editable **any time** (retroactive — whole season re-scores; existing swap snapshots stay frozen); structure (teams/divisions/playoffs/roster/draft settings) editable **only pre-draft**.

## Draft room

- Auto-starts at `draft_at` once the league is full (any open client claims the start via a guarded status update); commissioner can start manually anytime.
- Order: `random` snake, or `manual` — commissioner assigns pick numbers pre-draft (stored in `ff_teams.draft_pos`).
- Pick clock: deadline = previous pick's `created_at` (or `draft_started_at`) + `draft_clock` seconds. On expiry the **top-ranked available player is auto-picked** — by the on-clock owner's own client, or by the commissioner's client after ~4s grace. Enforcement is client-side (no server): if nobody has the room open, the clock fires when someone loads in.
- Pool sorted by expert rank; rows show overall rank chip, positional rank (e.g. RB3), team, bye week (computed from the full-season schedule, cached in localStorage).
- **Coach's Call**: heuristic recommender (`coachRecommend()`) — expert value + open starting spots + positional drop-off + "you need a K/DST, picks are running out" timing. Renders top pick with reasons + 2 alternates + draft button.
- **CPU teams** (testing/solo play): commissioner can fill open spots with bots (`cpu_*` accounts, 🤖). They autopick by rank & roster need **while the commissioner's draft room is open** (poll-driven). Leagues can be as small as 2 teams; playoff option `2` = championship game only.

## Season flow

- Lineups lock per-player at their real kickoff; before that, free slot edits. After kickoff → Live Coaching only.
- `teamWeekScore()` sums `slotScore()` over the league's slots; `slotScore` applies the swap formula when a swap row exists.
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
