# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working with Claude Code

**User Preference**: The user prefers to run all commands themselves. Do not execute bash commands without explicit permission. Provide the commands for the user to run instead.

## Project Overview

This is an automated NFL data collection service that syncs injury reports and weather data to JSON files via GitHub Actions. The data is sourced from ESPN APIs (for injuries) and weather.gov (for weather), then committed back to the repository automatically.

## Commands

### Running Scripts Locally

```bash
# Update injury data (creates both active and long-term files)
node scripts/update-injuries.js

# Update weather data
node scripts/update-weather.js

# Install dependencies
npm install
```

### Testing

```bash
npm test  # Currently returns success with no tests
```

## Architecture

### Data Flow

The system operates on a scheduled pull-update-commit cycle:

1. **Data Sources**
   - ESPN Roster API: Fetches NFL player rosters with injury statuses for all 32 teams
   - Weather.gov API: Fetches forecast data for outdoor stadium locations

2. **Data Processing**
   - `update-injuries.js`: Fetches all NFL team rosters, filters to skill positions (QB, RB, WR, TE), categorizes injuries by severity
   - `update-weather.js`: Calculates current NFL week, finds games for that week, includes ALL games (indoor games with `is_dome: true, weather: null`, outdoor games with fetched weather data)

3. **Player ID Mapping**
   - Uses `mappings/player-mapping.json` to translate ESPN IDs to internal player IDs
   - Players without mappings are logged but skipped in output

4. **Output Files**
   - `data/injuries-active.json`: Questionable, Doubtful, Out (game-time decisions)
   - `data/injuries-longterm.json`: IR and Suspended players
   - `data/weather-current.json`: ALL current week games - outdoor games include weather data, indoor/dome games marked with `is_dome: true` and `weather: null`

### GitHub Actions Workflows

The repository uses multiple scheduled workflows with different update frequencies:

- **injury-update.yml**: Regular injury updates (3x daily) - commits `injuries-active.json`
- **injury-longterm.yml**: Long-term injury updates (3x daily) - commits `injuries-longterm.json`
- **injury-gameday.yml**: High-frequency updates (15-min intervals) 2 hours before TNF/SNF/MNF kickoffs - commits `injuries-active.json`
- **weather-update.yml**: Regular weather updates (3x daily) - commits `weather-current.json`
- **weather-gameday.yml**: Gameday weather updates (timing TBD) - commits `weather-current.json`

**Important**: The workflows use `git stash` to separate active vs long-term injury commits. Each workflow only commits its specific target file.

### NFL Week Calculation

The current NFL week is calculated from a hardcoded season start date (`2025-09-03T00:00:00Z`) in both scripts. This logic appears in:
- `scripts/update-injuries.js:223-228`
- `scripts/update-weather.js:8-13`

### Rate Limiting

- ESPN API: 1 second delay between team requests (32 teams total)
- Weather.gov: 1.5 second delay between requests (requires User-Agent header)

### Reference Data Files

- `data/stadiums.json`: Stadium coordinates, dome/international flags
- `data/schedule.json`: NFL game schedule with dates and team matchups
- `mappings/player-mapping.json`: ESPN ID to internal player ID mapping

### Injury Categorization Logic

The categorization logic in `categorizeInjuries()` (update-injuries.js:83-135):

1. **Long-term** (injuries-longterm.json): IR or Suspended status
2. **Active** (injuries-active.json): Questionable, Doubtful, or Out designations

## Key Implementation Details

- Node.js 18+ required (specified in package.json engines)
- Uses native fetch API (node-fetch dependency for compatibility)
- All times processed in Eastern Time (TZ='America/New_York' in workflows)
- Weather data includes ALL games: outdoor stadiums get weather.gov API data, indoor/dome stadiums included with `is_dome: true` flag (international games skipped)
- Skill positions filter: QB, RB, WR, TE only
