// Player Mapping Generator (Sleeper player_id <-> ESPN athlete id)
// Rebuilds mappings/player-mapping.json — the table update-injuries.js uses
// to translate ESPN's injury feed into the Sleeper ids the app speaks.
// Unmapped players are DROPPED by the injury script, so every season's
// rookie class must land here before it lands on injured reserve.
//
// Sources (both public):
//   - Sleeper: https://api.sleeper.app/v1/players/nfl  (active, QB/RB/WR/TE,
//     on a team — same pare-down as the original 2025 hand-built mapping)
//   - ESPN: the SAME per-team roster endpoint update-injuries.js reads, so
//     the ids here are guaranteed to match the feed's ids.
//
// Match tiers (confidence recorded per entry):
//   1. Sleeper's own espn_id field, when present    -> HIGH  (espn_id)
//   2. normalized name + position + team            -> HIGH  (name_position_team)
//   3. normalized name + position, unique           -> MEDIUM (name_position)
//   4. mappings/manual-overrides.json               -> MANUAL (merged last, wins)
// Leftovers on both sides go to mappings/unmatched-report.json for review.
//
// Output schema is byte-compatible with the 2025 file; update-injuries.js
// needs no changes. Also logs a validation diff against the previous file.

const fs = require('fs').promises;
const path = require('path');

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

const SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/// "Marquise Brown Jr." / "D.K. Metcalf" / "Kenneth Walker III" all reduce
/// to comparable tokens.
function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/[^a-z\s]/g, '')                            // drop punctuation
    .split(/\s+/)
    .filter(t => t && !['jr', 'sr', 'ii', 'iii', 'iv', 'v'].includes(t))
    .join(' ');
}

async function fetchSleeperPlayers() {
  console.log('Fetching Sleeper player database...');
  const response = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!response.ok) throw new Error(`Sleeper HTTP ${response.status}`);
  const all = await response.json();

  const players = [];
  for (const [playerId, p] of Object.entries(all)) {
    if (!p.active || !p.team || !SKILL_POSITIONS.includes(p.position)) continue;
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    players.push({
      player_id: playerId,
      name,
      norm: normalizeName(name),
      position: p.position,
      team: p.team,
      espn_id: p.espn_id ? String(p.espn_id) : null,
      status: p.status || 'Active'
    });
  }
  console.log(`Sleeper: ${players.length} active skill-position players on teams`);
  return players;
}

async function fetchEspnPlayers() {
  const players = [];
  for (const team of NFL_TEAMS) {
    const url = `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams/${team.id}/roster`;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      (data.athletes || []).forEach(group => {
        (group.items || []).forEach(player => {
          const position = player.position?.abbreviation;
          if (SKILL_POSITIONS.includes(position)) {
            players.push({
              espn_id: player.id.toString(),
              name: player.displayName,
              norm: normalizeName(player.displayName),
              position,
              team: team.abbr
            });
          }
        });
      });
    } catch (error) {
      console.error(`ESPN roster failed for ${team.abbr}: ${error.message}`);
    }
    await delay(300);   // same politeness as the injury script
  }
  console.log(`ESPN: ${players.length} skill-position players across 32 rosters`);
  return players;
}

function buildMapping(sleeper, espn, overrides) {
  const espnById = new Map(espn.map(p => [p.espn_id, p]));
  const byNamePosTeam = new Map();
  const byNamePos = new Map();
  for (const p of espn) {
    const npt = `${p.norm}|${p.position}|${p.team}`;
    const np = `${p.norm}|${p.position}`;
    if (!byNamePosTeam.has(npt)) byNamePosTeam.set(npt, []);
    byNamePosTeam.get(npt).push(p);
    if (!byNamePos.has(np)) byNamePos.set(np, []);
    byNamePos.get(np).push(p);
  }

  const now = new Date().toISOString();
  const entries = [];
  const unmatchedSleeper = [];
  const usedEspnIds = new Set();

  const record = (s, e, confidence, matchType) => {
    entries.push({
      player_id: s.player_id,
      source_id: e.espn_id,
      source_name: e.name,
      player_name: s.name,
      position: s.position,
      source_team: e.team,
      player_team: s.team,
      confidence,
      match_type: matchType,
      player_status: s.status,
      created_at: now,
      updated_at: now
    });
    usedEspnIds.add(e.espn_id);
  };

  for (const s of sleeper) {
    // Tier 1: Sleeper already knows the ESPN id.
    if (s.espn_id && espnById.has(s.espn_id)) {
      record(s, espnById.get(s.espn_id), 'HIGH', 'espn_id');
      continue;
    }
    // Tier 2: name + position + team.
    const npt = byNamePosTeam.get(`${s.norm}|${s.position}|${s.team}`) || [];
    if (npt.length === 1) {
      record(s, npt[0], 'HIGH', 'name_position_team');
      continue;
    }
    // Tier 3: name + position, unique across the league (handles stale
    // team data on either side after moves).
    const np = byNamePos.get(`${s.norm}|${s.position}`) || [];
    if (np.length === 1) {
      record(s, np[0], 'MEDIUM', 'name_position');
      continue;
    }
    unmatchedSleeper.push({ player_id: s.player_id, name: s.name, position: s.position,
                            team: s.team, ambiguous_espn_candidates: np.length });
  }

  // Tier 4: manual overrides win over everything (replace or add).
  for (const o of overrides) {
    const idx = entries.findIndex(e => e.player_id === o.player_id);
    const entry = { confidence: 'MANUAL', match_type: 'manual_override',
                    created_at: now, updated_at: now, ...o };
    if (idx >= 0) entries[idx] = { ...entries[idx], ...entry };
    else entries.push(entry);
    usedEspnIds.add(String(o.source_id));
  }

  const unmatchedEspn = espn.filter(p => !usedEspnIds.has(p.espn_id))
    .map(p => ({ espn_id: p.espn_id, name: p.name, position: p.position, team: p.team }));

  entries.sort((a, b) => a.source_team === b.source_team
    ? a.player_name.localeCompare(b.player_name)
    : a.source_team.localeCompare(b.source_team));

  return { entries, unmatchedSleeper, unmatchedEspn };
}

async function main() {
  const mappingsDir = path.join(__dirname, '../mappings');
  const mappingPath = path.join(mappingsDir, 'player-mapping.json');
  const overridesPath = path.join(mappingsDir, 'manual-overrides.json');
  const reportPath = path.join(mappingsDir, 'unmatched-report.json');

  let overrides = [];
  try { overrides = JSON.parse(await fs.readFile(overridesPath, 'utf8')); }
  catch { console.log('No manual-overrides.json — proceeding without.'); }

  let previous = null;
  try { previous = JSON.parse(await fs.readFile(mappingPath, 'utf8')); }
  catch { console.log('No previous mapping found.'); }

  const [sleeper, espn] = [await fetchSleeperPlayers(), await fetchEspnPlayers()];
  const { entries, unmatchedSleeper, unmatchedEspn } = buildMapping(sleeper, espn, overrides);

  // Validation diff against the previous file: every old pair should
  // normally reappear identically (players who retired/were cut drop out).
  if (previous?.mapping) {
    const oldPairs = new Map(previous.mapping.map(e => [e.player_id, e.source_id]));
    let reproduced = 0, changed = 0;
    const missing = [];
    const newPairs = new Map(entries.map(e => [e.player_id, e.source_id]));
    for (const [pid, sid] of oldPairs) {
      if (!newPairs.has(pid)) missing.push(pid);
      else if (newPairs.get(pid) === sid) reproduced++;
      else changed++;
    }
    console.log(`Validation vs ${previous.version}: ${reproduced} reproduced, ` +
                `${changed} CHANGED, ${missing.length} dropped (retired/cut/off-roster)`);
    if (changed > 0) console.log('  ⚠ changed pairs deserve a look in unmatched-report.json');
  }

  const season = new Date().getFullYear() >= 2026 ? new Date().getFullYear() : 2026;
  const output = {
    version: `${season}.auto`,
    lastUpdated: new Date().toISOString().slice(0, 10),
    totalMappings: entries.length,
    mapping: entries
  };
  await fs.writeFile(mappingPath, JSON.stringify(output, null, 2));
  await fs.writeFile(reportPath, JSON.stringify({
    generated: new Date().toISOString(),
    unmatched_sleeper: unmatchedSleeper,
    unmatched_espn_sample: unmatchedEspn.slice(0, 100),
    unmatched_espn_total: unmatchedEspn.length
  }, null, 2));

  const byType = {};
  entries.forEach(e => { byType[e.match_type] = (byType[e.match_type] || 0) + 1; });
  console.log(`Wrote ${entries.length} mappings:`, JSON.stringify(byType));
  console.log(`Unmatched: ${unmatchedSleeper.length} Sleeper-side (see unmatched-report.json), ` +
              `${unmatchedEspn.length} ESPN-side`);
}

main().catch(err => { console.error(err); process.exit(1); });
