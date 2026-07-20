const { execFileSync } = require('child_process');
const path = require('path');
const { loadHistory, saveHistory, designationState, applySnapshot } = require('./injury-history');

// One-time backfill: replay every cron commit of the injury files and
// reconstruct the designation timeline back to the pipeline's first
// snapshot (2025-10-02). Run from anywhere inside the repo:
//
//   node scripts/backfill-injury-history.js
//
// Rerunnable: it always rebuilds from scratch (ignores any existing
// data/injury-history.json), so a rerun after a bug fix is safe.

const REPO_ROOT = path.join(__dirname, '..');
const ACTIVE = 'data/injuries-active.json';
const LONGTERM = 'data/injuries-longterm.json';

// A sane league-wide snapshot sees ~750-900 skill players. Anything
// far below that was a degraded fetch — skip it rather than record
// false recoveries. (First-ever snapshot: 758.)
const MIN_TOTAL_PLAYERS = 600;

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function fileAtCommit(sha, file) {
  try {
    return JSON.parse(git(['show', `${sha}:${file}`]));
  } catch (error) {
    return null; // file absent at this commit, or unparseable
  }
}

function isSane(snapshot) {
  return snapshot && typeof snapshot.summary?.total_players === 'number'
    && snapshot.summary.total_players >= MIN_TOTAL_PLAYERS;
}

async function backfill() {
  const log = git(['log', '--reverse', '--format=%H %cI', '--', ACTIVE, LONGTERM])
    .trim().split('\n').filter(Boolean)
    .map(line => {
      const [sha, date] = line.split(' ');
      return { sha, date };
    });

  console.log(`Replaying ${log.length} commits...`);

  const history = { lastUpdated: null, recordedSince: null, players: {} };
  let lastActive = null;
  let lastLongTerm = null;
  let applied = 0;
  let skipped = 0;
  let transitions = 0;

  for (const [i, { sha, date }] of log.entries()) {
    const active = fileAtCommit(sha, ACTIVE);
    const longTerm = fileAtCommit(sha, LONGTERM);

    // Carry the last sane version of each file forward; a commit only
    // touches one of them, and a degraded snapshot must not replace a
    // good one.
    if (isSane(active)) lastActive = active;
    else if (active) skipped++;
    if (isSane(longTerm)) lastLongTerm = longTerm;
    else if (longTerm) skipped++;

    if (!lastActive || !lastLongTerm) continue; // need both before diffing

    const state = designationState(lastActive, lastLongTerm);
    // League-wide files: absence from both buckets means healthy.
    transitions += applySnapshot(history, state, date.slice(0, 10), () => true);

    if (!history.recordedSince) history.recordedSince = date.slice(0, 10);
    history.lastUpdated = date;
    applied++;

    if ((i + 1) % 250 === 0) console.log(`  ${i + 1}/${log.length} commits, ${transitions} transitions`);
  }

  await saveHistory(history);

  const players = Object.keys(history.players).length;
  console.log('\n=== Backfill Summary ===');
  console.log(`Commits replayed: ${applied} (degraded snapshots skipped: ${skipped})`);
  console.log(`Players with history: ${players}`);
  console.log(`Transitions recorded: ${transitions}`);
  console.log(`Recorded since: ${history.recordedSince}`);
}

if (require.main === module) {
  backfill()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Backfill failed:', error);
      process.exit(1);
    });
}
