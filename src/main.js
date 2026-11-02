import { config } from './config.js';
import { runChecks } from './checks.js';
import { log } from './log.js';
import { runFreshPass, runRetryPass } from './pipeline.js';

// Overlap between fresh passes covers clock skew and mail that lands while a pass is running.
const OVERLAP_MS = 5 * 60_000;

const args = new Set(process.argv.slice(2));
const once = args.has('--once') || config.dryRun;

let stopping = false;
let wake = () => {};
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log.info(`${signal}: finishing the current message and exiting`);
    stopping = true;
    wake();
  });
}
const shouldStop = () => stopping;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function main() {
  await runChecks();
  if (args.has('--check')) return;

  let since = config.processAfter ?? new Date(Date.now() - config.startupLookbackHours * 3_600_000);
  let lastRetryAt = 0;
  log.info(`started${config.dryRun ? ' in DRY_RUN mode' : ''}, looking at mail after ${since.toISOString()}`);

  while (!stopping) {
    const cycleStart = Date.now();

    try {
      const { processed, failed } = await runFreshPass(since, shouldStop);
      if (processed || failed) log.info(`fresh pass: ${processed} processed, ${failed} failed`);
      // Move the window only when nothing failed; failed messages are still unlabeled and must be seen again.
      if (failed === 0 && !stopping) since = new Date(cycleStart - OVERLAP_MS);
    } catch (error) {
      log.error('fresh pass failed', error);
    }

    if (!stopping && cycleStart - lastRetryAt >= config.retryIntervalMin * 60_000) {
      try {
        const count = await runRetryPass(shouldStop);
        if (count) log.info(`retry pass: ${count} queued message(s) handled`);
        lastRetryAt = cycleStart;
      } catch (error) {
        log.error('retry pass failed', error);
      }
    }

    if (once) break;
    await sleep(config.pollIntervalSec * 1000);
  }
  log.info('stopped');
}

main().catch((error) => {
  log.error('fatal', error);
  process.exit(1);
});
