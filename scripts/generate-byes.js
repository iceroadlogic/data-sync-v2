// Generate byes.json — team bye weeks per season, as a reusable table.
// Historical seasons (2023–25) are DERIVED from Sleeper weekly stat lines:
// a team with no stat entries in a week was on bye. The current season
// comes from data/schedule.json (ESPN sync). One-shot but rerunnable —
// re-run after each season's schedule lands to extend the table.
//
// Output: data/byes.json  { generated, seasons: { "2023": { ARI: 14, ... } } }

const fs = require('fs').promises;
const path = require('path');

const HISTORICAL_SEASONS = [2023, 2024, 2025];
const REGULAR_SEASON_WEEKS = 18;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function deriveSeasonByes(season) {
  console.log(`Deriving ${season} byes from Sleeper weekly stats...`);
  const teamsByWeek = {};
  const allTeams = new Set();

  for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
    const url = `https://api.sleeper.app/stats/nfl/${season}/${week}?season_type=regular`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${season} week ${week}`);
    }
    const entries = await response.json();
    const teams = new Set();
    entries.forEach(entry => {
      if (entry.team) teams.add(entry.team);
    });
    teamsByWeek[week] = teams;
    teams.forEach(t => allTeams.add(t));
    console.log(`  week ${week}: ${teams.size} teams played`);
    await delay(300);
  }

  const byes = {};
  allTeams.forEach(team => {
    const missedWeeks = [];
    for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
      if (!teamsByWeek[week].has(team)) missedWeeks.push(week);
    }
    if (missedWeeks.length !== 1) {
      console.warn(`  ⚠️ ${team} absent in ${missedWeeks.length} weeks: ${missedWeeks} — using first`);
    }
    if (missedWeeks.length > 0) byes[team] = missedWeeks[0];
  });
  console.log(`  ${Object.keys(byes).length} teams`);
  return byes;
}

async function scheduleByes() {
  const schedulePath = path.join(__dirname, '../data/schedule.json');
  const schedule = JSON.parse(await fs.readFile(schedulePath, 'utf8'));
  const season = String(schedule.season);
  console.log(`Deriving ${season} byes from schedule.json...`);

  const teamsByWeek = {};
  const allTeams = new Set();
  schedule.games.forEach(game => {
    if (game.week < 1 || game.week > REGULAR_SEASON_WEEKS) return;
    teamsByWeek[game.week] = teamsByWeek[game.week] || new Set();
    [game.home.team, game.away.team].forEach(t => {
      teamsByWeek[game.week].add(t);
      allTeams.add(t);
    });
  });

  const byes = {};
  allTeams.forEach(team => {
    for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
      if (!(teamsByWeek[week] || new Set()).has(team)) {
        byes[team] = week;
        break;
      }
    }
  });
  console.log(`  ${Object.keys(byes).length} teams`);
  return { season, byes };
}

async function main() {
  const seasons = {};
  for (const season of HISTORICAL_SEASONS) {
    seasons[String(season)] = await deriveSeasonByes(season);
  }
  const current = await scheduleByes();
  seasons[current.season] = current.byes;

  const output = {
    generated: new Date().toISOString(),
    note: 'Team bye weeks per season. 2023-25 derived from Sleeper weekly stat lines; current season from schedule.json.',
    seasons
  };
  const outPath = path.join(__dirname, '../data/byes.json');
  await fs.writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}: seasons ${Object.keys(seasons).join(', ')}`);
}

main().catch(error => {
  console.error('Failed:', error);
  process.exit(1);
});
