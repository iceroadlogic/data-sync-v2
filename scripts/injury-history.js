const fs = require('fs').promises;
const path = require('path');

// Append-only injury designation timeline. Each entry is a dated
// transition (Healthy -> Questionable, Questionable -> Out, ...) per
// Sleeper player_id. The last transition's "to" IS the player's
// current recorded state — the file carries its own baseline, so a
// degraded fetch or a skipped run never corrupts the timeline.

const HISTORY_PATH = path.join(__dirname, '../data/injury-history.json');
const HEALTHY = 'Healthy';

// Bucket key -> recorded designation name
const DESIGNATIONS = {
  questionable: 'Questionable',
  doubtful: 'Doubtful',
  out: 'Out',
  ir: 'IR',
  suspended: 'Suspended'
};

async function loadHistory() {
  try {
    return JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8'));
  } catch (error) {
    return { lastUpdated: null, recordedSince: null, players: {} };
  }
}

async function saveHistory(history) {
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
}

// Flatten the injuries-active / injuries-longterm bucket files into
// one map: sleeper player_id -> current designation record. Either
// file may be null (not present yet at that point in git history).
function designationState(activeData, longTermData) {
  const state = {};
  [activeData, longTermData].forEach(file => {
    if (!file) return;
    Object.entries(DESIGNATIONS).forEach(([bucket, designation]) => {
      (file[bucket] || []).forEach(p => {
        if (!p.player_id) return;
        state[p.player_id] = {
          to: designation,
          detail: p.injury_detail || p.injury_description || null,
          team: p.team_abbr || null,
          name: p.player_name,
          position: p.position || null
        };
      });
    });
  });
  return state;
}

function lastState(history, playerId) {
  const transitions = history.players[playerId]?.transitions;
  return transitions?.length ? transitions[transitions.length - 1].to : HEALTHY;
}

// Diff one snapshot against the recorded baseline and append the
// transitions. `isCovered(playerId)` says whether the player's ABSENCE
// from the snapshot is meaningful (true = he was observed healthy;
// false = he simply wasn't in this fetch, leave his state alone).
// Returns the number of transitions appended.
function applySnapshot(history, currentState, dateStr, isCovered) {
  let appended = 0;

  const record = (playerId, from, to, info) => {
    if (!history.players[playerId]) {
      history.players[playerId] = { name: info.name, position: info.position, transitions: [] };
    }
    const player = history.players[playerId];
    if (info.name) player.name = info.name;
    if (info.position) player.position = info.position;
    const transition = { date: dateStr, from, to };
    if (info.detail) transition.detail = info.detail;
    if (info.team) transition.team = info.team;
    player.transitions.push(transition);
    appended++;
  };

  // New or changed designations
  Object.entries(currentState).forEach(([playerId, current]) => {
    const from = lastState(history, playerId);
    if (from !== current.to) record(playerId, from, current.to, current);
  });

  // Recoveries: previously designated, now absent from a snapshot that
  // covers them
  Object.keys(history.players).forEach(playerId => {
    const from = lastState(history, playerId);
    if (from === HEALTHY || currentState[playerId] || !isCovered(playerId)) return;
    const player = history.players[playerId];
    record(playerId, from, HEALTHY, { name: player.name, position: player.position });
  });

  return appended;
}

module.exports = { HISTORY_PATH, HEALTHY, loadHistory, saveHistory, designationState, lastState, applySnapshot };
