const fs = require('fs').promises;
const path = require('path');

// Rate limiting delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Calculate current NFL week
function getCurrentNFLWeek() {
  const now = new Date();
  const seasonStart = new Date('2025-09-03T00:00:00Z');
  const daysSinceStart = Math.floor((now - seasonStart) / (1000 * 60 * 60 * 24));
  return Math.min(Math.floor(daysSinceStart / 7) + 1, 18);
}

// Load stadium data
async function loadStadiums() {
  try {
    const stadiumPath = path.join(__dirname, '../data/stadiums.json');
    const data = await fs.readFile(stadiumPath, 'utf8');
    const stadiumData = JSON.parse(data);

    // Create lookup map: team_code -> stadium
    const stadiumLookup = {};
    stadiumData.stadiums.forEach(stadium => {
      stadiumLookup[stadium.team_code] = stadium;
    });

    return stadiumLookup;
  } catch (error) {
    console.error('Error loading stadium data:', error);
    throw error;
  }
}

// Load schedule data
async function loadSchedule() {
  try {
    const schedulePath = path.join(__dirname, '../data/schedule.json');
    const data = await fs.readFile(schedulePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading schedule data:', error);
    throw error;
  }
}

// Fetch weather from weather.gov
async function getWeatherForGame(gameId, stadium, gameDate) {
  try {
    console.log(`Fetching weather for ${stadium.name} (${stadium.city})`);

    const { latitude, longitude } = stadium;

    // Step 1: Get grid point for coordinates
    const gridResponse = await fetch(
      `https://api.weather.gov/points/${latitude},${longitude}`,
      {
        headers: {
          'User-Agent': 'fantasy-data-sync (github.com/iceroadlogic/data-sync-v2)',
          'Accept': 'application/json'
        }
      }
    );

    if (!gridResponse.ok) {
      throw new Error(`Grid API error: ${gridResponse.status}`);
    }

    const gridData = await gridResponse.json();
    const { gridId, gridX, gridY } = gridData.properties;

    // Step 2: Get forecast for the area
    const forecastResponse = await fetch(
      `https://api.weather.gov/gridpoints/${gridId}/${gridX},${gridY}/forecast`,
      {
        headers: {
          'User-Agent': 'fantasy-data-sync (github.com/iceroadlogic/data-sync-v2)',
          'Accept': 'application/json'
        }
      }
    );

    if (!forecastResponse.ok) {
      throw new Error(`Forecast API error: ${forecastResponse.status}`);
    }

    const forecastData = await forecastResponse.json();

    // Step 3: Find forecast period closest to game time
    const gameDateObj = new Date(gameDate);
    const forecastPeriod = findClosestForecast(forecastData.properties.periods, gameDateObj);

    if (!forecastPeriod) {
      console.warn(`No forecast found for game ${gameId}`);
      return null;
    }

    // Step 4: Format weather data
    const precipValue = forecastPeriod.probabilityOfPrecipitation?.value || 0;

    return {
      temp: forecastPeriod.temperature,
      wind: `${forecastPeriod.windSpeed} ${forecastPeriod.windDirection}`,
      conditions: forecastPeriod.shortForecast,
      precipitation: `${precipValue}%`
    };

  } catch (error) {
    console.error(`Weather API error for game ${gameId}:`, error.message);
    return null;
  }
}

// Find closest forecast period to game time
function findClosestForecast(periods, gameDate) {
  let closestPeriod = null;
  let closestDiff = Infinity;

  for (const period of periods) {
    const periodStart = new Date(period.startTime);
    const periodEnd = new Date(period.endTime);

    // Check if game time falls within this period
    if (gameDate >= periodStart && gameDate <= periodEnd) {
      return period;
    }

    // Find closest period if exact match not found
    const diffStart = Math.abs(gameDate - periodStart);
    const diffEnd = Math.abs(gameDate - periodEnd);
    const minDiff = Math.min(diffStart, diffEnd);

    if (minDiff < closestDiff) {
      closestDiff = minDiff;
      closestPeriod = period;
    }
  }

  return closestPeriod;
}

async function updateWeatherData() {
  console.log('Starting weather data update...');

  // Load data files
  const stadiumLookup = await loadStadiums();
  const scheduleData = await loadSchedule();

  console.log(`Loaded ${Object.keys(stadiumLookup).length} stadiums`);
  console.log(`Loaded ${scheduleData.games.length} games`);

  // Get current week
  const currentWeek = getCurrentNFLWeek();
  console.log(`Current NFL week: ${currentWeek}`);

  // Filter games for current week
  const weekGames = scheduleData.games.filter(game => game.week === currentWeek);
  console.log(`Found ${weekGames.length} games in week ${currentWeek}`);

  // Process games
  const weatherGames = [];
  let processed = 0;
  let skipped = 0;

  for (const game of weekGames) {
    const homeTeam = game.home.team;
    const stadium = stadiumLookup[homeTeam];

    if (!stadium) {
      console.warn(`No stadium found for team: ${homeTeam}`);
      skipped++;
      continue;
    }

    // Skip domes and international stadiums
    if (stadium.is_dome) {
      console.log(`Skipping ${stadium.name} - dome/indoor`);
      skipped++;
      continue;
    }

    if (stadium.is_international) {
      console.log(`Skipping ${stadium.name} - international venue`);
      skipped++;
      continue;
    }

    // Fetch weather for outdoor US stadiums
    const weather = await getWeatherForGame(game.espn_event_id, stadium, game.date);

    if (weather) {
      weatherGames.push({
        game_id: game.espn_event_id,
        home_team: game.home.team,
        away_team: game.away.team,
        stadium: stadium.name,
        is_dome: false,
        weather: weather
      });

      console.log(`✓ ${game.away.team} @ ${game.home.team}: ${weather.temp}°F, ${weather.conditions}`);
      processed++;
    }

    // Rate limiting - weather.gov requires minimum 1 second between requests
    await delay(1500);
  }

  // Create output data
  const outputData = {
    week: currentWeek,
    lastUpdated: new Date().toISOString(),
    games: weatherGames
  };

  // Write to file
  const outputPath = path.join(__dirname, '../data/weather-current.json');
  await fs.writeFile(outputPath, JSON.stringify(outputData, null, 2));

  console.log('\n=== Weather Update Summary ===');
  console.log(`Week: ${currentWeek}`);
  console.log(`Total games: ${weekGames.length}`);
  console.log(`Weather fetched: ${processed}`);
  console.log(`Skipped (dome/international): ${skipped}`);
  console.log(`Output: weather-current.json`);

  return outputData;
}

// Run if called directly
if (require.main === module) {
  updateWeatherData()
    .then(data => {
      console.log('\n✅ Weather update completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Weather update failed:', error);
      process.exit(1);
    });
}

module.exports = { updateWeatherData };
