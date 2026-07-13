# data-sync-v2

The data pipeline for **DynastyContext** (the iOS Sleeper companion app).
GitHub Actions fetch NFL data on schedules, commit the JSON into `data/`,
and GitHub Pages serves it to the app. **Pushing to `main` IS deploying.**

The app consumes everything from:

```
https://iceroadlogic.github.io/data-sync-v2/data/<file>.json
```

(The one exception: `schedule.json` is also *bundled inside the app* at
`FootballViewer/Resources/schedule.json` — copy it over and rebuild the app
whenever it's regenerated.)

## Data files

| File | What | Producer | Cadence |
|---|---|---|---|
| `data/injuries-active.json` | Current-week injury designations | `scripts/update-injuries.js` | Hourly + 15-min bursts around games |
| `data/injuries-longterm.json` | IR/PUP/long-term statuses | same script (longterm mode) | 3×/day Mon–Sat |
| `data/injuries.json` | Legacy combined file | same | — |
| `data/weather-current.json` | Weather for the current week's outdoor games | `scripts/update-weather.js` | Hourly + game-day bursts. Offseason: `{week: 0, games: []}` (correct behavior) |
| `data/schedule.json` | Full season schedule, 272 games | `scripts/generate-schedule.js` — **run manually once per year** | Yearly (see runbook) |
| `data/stadiums.json` | Venue metadata (dome/outdoor etc.) | hand-maintained | Rarely |
| `mappings/player-mapping.json` | ESPN↔Sleeper player id mapping | hand/one-off | Rarely |

## Workflows (.github/workflows/)

- `injury-update.yml` / `weather-update.yml` — the hourly baseline.
- `injury-gameday.yml` / `weather-gameday.yml` — 15-minute cadence windows
  around Thu/Sun/Mon games (cron windows are in ET-converted UTC; comments
  in each file).
- `injury-longterm.yml` — 3×/day Mon–Sat.
- All support `workflow_dispatch` (manual run from the Actions tab).
- Each job commits its output file directly to `main` as "GitHub Action".

These ran unattended for 6+ months (Jan–Jul 2026) without failure.

## Yearly runbook (July, once the NFL schedule is out)

1. `node scripts/generate-schedule.js <season>` (Node 18+; on Tom's MacBook
   node lives at `/opt/homebrew/bin/node`).
   - Fetches all 18 weeks from ESPN's public scoreboard API.
   - Normalizes team abbreviations to the app's set (`WSH→WAS`).
   - Marks international games with **`venue.state = "XX"`** — the app's
     Int'l filter convention (2026: 9 games incl. Melbourne, Rio, Madrid).
   - Hard-validates: 272 games, 32 teams × exactly 17 appearances; prints
     the derived bye weeks. **Fails loudly rather than writing bad data.**
2. Cross-check the printed bye weeks against the app's `ByeWeeks.swift`
   table (update it if it doesn't match — in 2026 it already did).
3. Copy `data/schedule.json` → app repo `FootballViewer/Resources/schedule.json`,
   rebuild the app.
4. Update the season-start fallback date in `scripts/update-weather.js`
   (`seasonStart` — the Wednesday before the opener; primary source is
   Sleeper's `/v1/state/nfl` so the fallback rarely matters).
5. Commit + push this repo (deploys via Pages).

## History note

The 2025 `schedule.json` was produced by an uncommitted one-off script (on
the Dell laptop) — regeneration meant rebuilding the tool. As of 2026-07-12
the generator is committed here; a season rollover is a re-run, not
archaeology. Keep it that way: **any script that produces a committed data
file gets committed with it.**

## App-side consumers (for cross-repo debugging)

- `InjuryManager.swift` — injuries files (baseURL points at Pages).
- `NFLGametimeWeatherScreen.swift` — weather-current.json.
- `ScheduleService.swift` — the *bundled* schedule.json (not Pages).
- `StadiumService.swift` — stadiums.json.
