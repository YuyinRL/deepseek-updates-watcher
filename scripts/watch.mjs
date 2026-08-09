import { setTimeout as sleep } from 'node:timers/promises';
import { runCheck } from './check-updates.mjs';

const intervalSeconds = Number.parseInt(process.env.CHECK_INTERVAL_SECONDS || '300', 10);
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 60) {
  throw new Error('CHECK_INTERVAL_SECONDS must be an integer greater than or equal to 60');
}

const intervalMs = intervalSeconds * 1000;
let stopping = false;
const stopController = new AbortController();

function log(message) {
  console.log(`[${new Date().toISOString()}] [runner] ${message}`);
}

function requestStop(signal) {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}; stopping after the current check`);
  stopController.abort();
}

process.once('SIGTERM', () => requestStop('SIGTERM'));
process.once('SIGINT', () => requestStop('SIGINT'));

log(`watcher started; interval=${intervalSeconds}s`);

while (!stopping) {
  try {
    const code = await runCheck();
    if (code !== 0) log(`check completed with exit code ${code}; retrying at the next interval`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [runner] check failed: ${err.stack || err.message}`);
  }

  if (stopping) break;

  // Run immediately on startup, then align checks to wall-clock interval boundaries.
  const delay = intervalMs - (Date.now() % intervalMs);
  log(`next check in ${Math.ceil(delay / 1000)}s`);
  try {
    await sleep(delay, undefined, { signal: stopController.signal });
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
}

log('watcher stopped');
