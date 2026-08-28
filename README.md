# 🎧🏈 Gridiron GM — Fantasy Football with Live Coaching

A full fantasy football league app. It plays like the fantasy apps you already know — Yahoo, NFL, CBS — with one groundbreaking twist: **Live Coaching**.

## 🎧 Live Coaching — the groundbreaking part

Just like a real coach can sub a player at any moment of a game, you can sub a fantasy starter **mid-game**:

- Your starter is stinking it up at 10:38 of the first quarter? Sub him out **right now**.
- He keeps only the points he scored **before** the sub — snapshotted at the moment you make the call.
- Your sub scores for you **from that moment forward**. If he was already playing, everything he scored while on your bench does **not** count — only points after the sub.
- **One live sub per position per week**, no undo. Make the call, coach.
- You can only sub in a player who **hasn't already played** (his game must not be final), and you can't sit a player unless you have a replacement — same-position bench player required.
- Normal lineup changes stay free until each player's kickoff; once his game starts the slot locks and Live Coaching is your only move.

Scoring math for a subbed slot: `out_points_at_swap + (in_player_final − in_points_at_swap)` — both snapshots frozen in the database at the moment of the swap.

## Everything else — the rules that already exist

- **Sign up** with name, username, email, age group, and favorite team. Sign back in with just your email.
- **Create a league**: pick an even number of teams (4–16), optional divisions (e.g. 12 teams → 2×6, 3×4, or 4×3), 4- or 6-team playoffs, and a draft date. You get an invite code + shareable link (`?join=CODE`) to send your friends.
- **Roster construction is the commissioner's call**: how many QB, RB, WR, TE (if any), FLEX (if any), K, DEF, and bench spots — from 0 of a position up to 5. The draft automatically becomes as many rounds as the roster has spots, and every lineup, matchup, and live-sub screen follows the league's slots.
- **Scoring is the commissioner's call too**: apply a preset (full PPR, half PPR, non-PPR) or set every point value — TDs, INTs, receptions, fumbles, kicking, D/ST. Yardage rules support two modes:
  - *every yard counts* — fractional, e.g. 1 pt per 25 yds means 113 yds = 4.52
  - *whole chunks only* — strict, e.g. **10 pts per 10 yds means 7 yards = 0** (the chunk wasn't completed; 27 yards = 20)

  Raw stat lines are shared league-to-league, but every league re-scores them with its own rules — including the live-coaching point snapshots.
- **Season length**: the NFL plays 18 weeks, but the fantasy season is **17 — always total weeks minus one** — because nobody plays their starters in Week 18.
  - 6-team playoffs: regular season weeks 1–14, quarterfinals W15 (top 2 seeds bye), semis W16, championship W17.
  - 4-team playoffs: regular season weeks 1–15, semis W16, championship W17.
  - Division winners qualify first (best record, then points for), wildcards fill the rest.
- **Live snake draft** at the scheduled date: commissioner starts it, order is randomized, 15 rounds (9 starters + 6 bench), the board updates live for everyone.
- **Rosters/lineups**: QB, 2 RB, 2 WR, TE, FLEX (RB/WR/TE), K, D/ST + 6 bench. Weekly head-to-head matchups on a round-robin schedule; standings, playoff bracket, and a league champion.
- **Free agency**: add/drop any unowned player (with a drop prompt when your roster is full).
- **Player profiles**: click any player for headshot, last season's full weekly stats, and this season's week-by-week log (from ESPN).
- **Default scoring** (standard PPR, editable per league): pass yds 1/25 · pass TD 4 · INT −2 · rush/rec yds 1/10 · rush/rec TD 6 · reception 1 · fumble lost −2 · FG 3 (+1 at 40–49, +2 at 50+) · XP 1 · D/ST: sack 1, INT 2, fumble rec 2, TD 6, safety 2, points-allowed tiers 10/7/4/1/0/−1/−4.

## Live stats

Player stats sync from ESPN's public APIs right in the browser: the weekly scoreboard finds live games, box scores are parsed into per-player stat lines and fantasy points, and results are cached in `ff_player_week_stats` so the whole league shares them. Live games refresh automatically about once a minute; ⟳ forces it.

## Running it

Static site, no build step:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Backend is Supabase (project `kixdpoizujvnwsyqgmqe`, already configured in `app.js`) with an independent `ff_`-prefixed schema:

| Table | Purpose |
| --- | --- |
| `ff_players` | sign-ups (name, username, email, age group, favorite team) |
| `ff_leagues` | leagues: size, divisions, playoff format, invite code, draft date, status |
| `ff_teams` | one fantasy team per player per league |
| `ff_nfl_players` | the NFL player pool (seeded; refreshed from ESPN rosters in-browser) |
| `ff_draft_picks` | draft board (a DB trigger copies picks onto rosters) |
| `ff_rosters` | who owns whom |
| `ff_lineups` | weekly starting lineups by slot |
| `ff_swaps` | 🎧 live-coaching subs with point snapshots (unique per slot per week) |
| `ff_matchups` | the round-robin schedule |
| `ff_player_week_stats` | synced per-player weekly stats + computed fantasy points |

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell: auth, league hub, league screens, modals |
| `styles.css` | Dark, sporty theme |
| `app.js` | Everything: auth, leagues, draft, lineups, live coaching, scoring, ESPN sync |
| `vendor/supabase.js` | Vendored supabase-js v2 (no CDN dependency) |
