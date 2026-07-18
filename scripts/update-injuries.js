const fs = require('fs').promises;
const path = require('path');

// NFL team abbreviations and IDs
const NFL_TEAMS = [
  { abbr: 'ARI', id: 22 }, { abbr: 'ATL', id: 1 }, { abbr: 'BAL', id: 33 }, { abbr: 'BUF', id: 2 },
  { abbr: 'CAR', id: 29 }, { abbr: 'CHI', id: 3 }, { abbr: 'CIN', id: 4 }, { abbr: 'CLE', id: 5 },
  { abbr: 'DAL', id: 6 }, { abbr: 'DEN', id: 7 }, { abbr: 'DET', id: 8 }, { abbr: 'GB', id: 9 },
  { abbr: 'HOU', id: 34 }, { abbr: 'IND', id: 11 }, { abbr: 'JAX', id: 30 }, { abbr: 'KC', id: 12 },
  { abbr: 'LV', id: 13 }, { abbr: 'LAC', id: 24 }, { abbr: 'LAR', id: 14 }, { abbr: 'MIA', id: 15 },
  { abbr: 'MIN', id: 16 }, { abbr: 'NE', id: 17 }, { abbr: 'NO', id: 18 }, { abbr: 'NYG', id: 19 },
  { abbr: 'NYJ', id: 20 }, { abbr: 'PHI', id: 21 }, { abbr: 'PIT', id: 23 }, { abbr: 'SF', id: 25 },
  { abbr: 'SEA', id: 26 }, { abbr: 'TB', id: 27 }, { abbr: 'TEN', id: 10 }, { abbr: 'WAS', id: 28 }
];

// Rate limiting delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loadPlayerMapping() {
  try {
    const mappingPath = path.join(__dirname, '../mappings/player-mapping.json');
    const mappingData = await fs.readFile(mappingPath, 'utf8');
    const mapping = JSON.parse(mappingData);

    // Create lookup map: ESPN ID -> Player Data
    const lookupMap = {};
    mapping.mapping.forEach(player => {
      lookupMap[player.source_id] = player;
    });

    return lookupMap;
  } catch (error) {
    console.error('Error loading player mapping:', error);
    return {};
  }
}

// ESPN's dedicated injuries API — one request for the whole league.
// Richer than the roster feed: injury type ("Knee - Meniscus"), an
// estimated return date, and a beat-writer comment per injury.
async function fetchInjuryDetails() {
  try {
    console.log('Fetching ESPN injury details (return dates, comments)...');
    const url = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for injuries feed`);
    }
    const data = await response.json();

    // ESPN athlete id -> { detail, returnDate, comment }. The feed's
    // athlete object carries no bare id — extract it from the player
    // link (/id/12345/) or the headshot filename.
    const detailsById = {};
    (data.injuries || []).forEach(team => {
      (team.injuries || []).forEach(injury => {
        const link = injury.athlete?.links?.[0]?.href || '';
        const headshot = injury.athlete?.headshot?.href || '';
        const athleteId = (link.match(/\/id\/(\d+)/) || headshot.match(/\/full\/(\d+)\.png/) || [])[1];
        if (!athleteId) return;
        detailsById[athleteId] = {
          detail: injury.details?.type || null,
          returnDate: injury.details?.returnDate || null,
          comment: injury.shortComment || null
        };
      });
    });
    console.log(`Injury details for ${Object.keys(detailsById).length} players`);
    return detailsById;
  } catch (error) {
    console.error('Error fetching injury details:', error.message);
    return {};   // enrichment is optional — the base pipeline still works
  }
}

async function fetchTeamInjuryData(teamId, teamAbbr) {
  try {
    console.log(`Fetching injury data for ${teamAbbr}...`);

    const url = `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/roster`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for team ${teamAbbr}`);
    }

    const data = await response.json();
    const players = [];

    // Process roster data
    if (data.athletes) {
      data.athletes.forEach(group => {
        if (group.items) {
          group.items.forEach(player => {
            // Only include skill positions
            const position = player.position?.abbreviation;
            if (['QB', 'RB', 'WR', 'TE'].includes(position)) {
              players.push({
                espn_id: player.id.toString(),
                name: player.displayName,
                position: position,
                team: teamAbbr,
                status: player.status?.type || 'Active',
                injury: player.injuries?.[0] || null
              });
            }
          });
        }
      });
    }

    console.log(`Found ${players.length} skill position players for ${teamAbbr}`);
    return players;

  } catch (error) {
    console.error(`Error fetching ${teamAbbr}:`, error.message);
    return [];
  }
}

function categorizeInjuries(players, playerMapping, injuryDetails = {}) {
  const active = {
    questionable: [],
    doubtful: [],
    out: []
  };

  const longTerm = {
    ir: [],
    suspended: []
  };

  players.forEach(player => {
    // Look up player in mapping
    const mappedPlayer = playerMapping[player.espn_id];
    if (!mappedPlayer) {
      console.log(`No mapping found for ${player.name} (ESPN ID: ${player.espn_id})`);
      return;
    }

    const details = injuryDetails[player.espn_id] || {};
    const injuryData = {
      player_id: mappedPlayer.player_id,
      source_id: player.espn_id,
      player_name: player.name,
      position: player.position,
      team_abbr: player.team,
      injury_status: player.status,
      injury_designation: player.injury?.status || null,
      injury_description: player.injury?.details || null,
      // Enrichment from ESPN's dedicated injuries feed (nullable — the
      // feed doesn't cover every roster-flagged player)
      injury_detail: details.detail || null,
      est_return_date: details.returnDate || null,
      injury_comment: details.comment || null
    };

    // Categorize based on status and designation
    const status = player.status.toLowerCase();
    const designation = player.injury?.status?.toLowerCase() || '';

    // Long-term injuries (IR, Suspended)
    if (designation.includes('injured reserve') || status.includes('reserve')) {
      longTerm.ir.push(injuryData);
    } else if (designation.includes('suspension') || status.includes('suspension')) {
      longTerm.suspended.push(injuryData);
    }
    // Active game-time decisions (Questionable, Doubtful, Out)
    else if (status === 'out' || designation === 'out') {
      active.out.push(injuryData);
    } else if (designation === 'doubtful') {
      active.doubtful.push(injuryData);
    } else if (designation === 'questionable') {
      active.questionable.push(injuryData);
    }
  });

  return { active, longTerm };
}

async function updateInjuryData() {
  console.log('Starting injury data update...');

  // Load player mapping
  const playerMapping = await loadPlayerMapping();
  console.log(`Loaded mapping for ${Object.keys(playerMapping).length} players`);

  // One-shot league-wide injury details (return dates, comments)
  const injuryDetails = await fetchInjuryDetails();

  const allPlayers = [];
  let successCount = 0;
  let errorCount = 0;

  // Fetch data for all teams
  for (const team of NFL_TEAMS) {
    try {
      const players = await fetchTeamInjuryData(team.id, team.abbr);
      allPlayers.push(...players);
      successCount++;

      // Rate limiting - be respectful to ESPN
      await delay(1000);

    } catch (error) {
      console.error(`Failed to fetch data for ${team.abbr}:`, error);
      errorCount++;
    }
  }

  console.log(`Successfully fetched from ${successCount}/32 teams`);
  console.log(`Total players found: ${allPlayers.length}`);

  // Categorize injuries into active and long-term
  const { active, longTerm } = categorizeInjuries(allPlayers, playerMapping, injuryDetails);

  const currentWeek = await getCurrentNFLWeek();
  const timestamp = new Date().toISOString();

  // Create active injuries output (questionable, doubtful, out)
  const activeData = {
    lastUpdated: timestamp,
    week: currentWeek,
    summary: {
      total_players: allPlayers.length,
      questionable: active.questionable.length,
      doubtful: active.doubtful.length,
      out: active.out.length
    },
    questionable: active.questionable,
    doubtful: active.doubtful,
    out: active.out
  };

  // Create long-term injuries output (IR, suspended)
  const longTermData = {
    lastUpdated: timestamp,
    week: currentWeek,
    summary: {
      total_players: allPlayers.length,
      ir: longTerm.ir.length,
      suspended: longTerm.suspended.length
    },
    ir: longTerm.ir,
    suspended: longTerm.suspended
  };

  // Write both files
  const activePath = path.join(__dirname, '../data/injuries-active.json');
  const longTermPath = path.join(__dirname, '../data/injuries-longterm.json');

  await fs.writeFile(activePath, JSON.stringify(activeData, null, 2));
  await fs.writeFile(longTermPath, JSON.stringify(longTermData, null, 2));

  console.log('\n=== Injury Data Update Summary ===');
  console.log('Active Injuries (injuries-active.json):');
  console.log(`  - Questionable: ${active.questionable.length}`);
  console.log(`  - Doubtful: ${active.doubtful.length}`);
  console.log(`  - Out: ${active.out.length}`);
  console.log('Long-Term Injuries (injuries-longterm.json):');
  console.log(`  - IR: ${longTerm.ir.length}`);
  console.log(`  - Suspended: ${longTerm.suspended.length}`);

  return {
    active: activeData.summary,
    longTerm: longTermData.summary
  };
}

async function getCurrentNFLWeek() {
  try {
    console.log('Fetching current NFL week from Sleeper API...');
    const response = await fetch('https://api.sleeper.app/v1/state/nfl');

    if (!response.ok) {
      throw new Error(`Sleeper API error: ${response.status}`);
    }

    const state = await response.json();
    console.log(`NFL Season: ${state.season}, Week: ${state.week}, Type: ${state.season_type}`);

    return state.week;
  } catch (error) {
    console.error('Error fetching NFL week from Sleeper API:', error.message);
    console.log('Falling back to calculated week...');

    // Fallback to calculation if API fails
    const now = new Date();
    const seasonStart = new Date('2025-09-03T00:00:00Z');
    const daysSinceStart = Math.floor((now - seasonStart) / (1000 * 60 * 60 * 24));
    return Math.min(Math.floor(daysSinceStart / 7) + 1, 18);
  }
}

// Run if called directly
if (require.main === module) {
  updateInjuryData()
    .then(summary => {
      console.log('Update completed:', summary);
      process.exit(0);
    })
    .catch(error => {
      console.error('Update failed:', error);
      process.exit(1);
    });
}

module.exports = { updateInjuryData };