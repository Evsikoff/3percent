import { config } from './config.js';
import { extractQuote, freshChain, retryChain } from './ai.js';
import * as bitrix from './bitrix.js';
import { parseEmail } from './email.js';
import * as gmail from './gmail.js';
import { log } from './log.js';
import * as supabase from './supabase.js';

const { labels } = config;
const ERROR_LABELS = [labels.aiError, labels.bitrixError];
const FINAL_LABELS = [labels.ok, labels.noQuote];
const ALL_LABELS = [...FINAL_LABELS, ...ERROR_LABELS];

const hasAny = (labelIds, wanted) => labelIds.some((id) => wanted.includes(id));
const isSuccess = (result) => result.status === 'SUCCESS' && Boolean(result.quote_number) && Boolean(result.processed_text);

// Every write goes through here so DRY_RUN can show what would happen without touching anything.
async function write(description, action) {
  if (config.dryRun) {
    log.info(`[dry-run] ${description}`);
    return;
  }
  await action();
}

const setLabels = (id, change) =>
  write(`labels ${id}: +${change.add ?? []} -${change.remove ?? []}`, () => gmail.modifyLabels(id, change));

const recordMissed = (id, subject, error) =>
  write(`missed_messages += ${id} (${error})`, () => supabase.insertMissed({ messageId: id, subject, error }));

const postComment = (result) =>
  write(`Bitrix comment on quote ${result.quote_number}:\n${result.processed_text}`, () =>
    bitrix.addQuoteComment(result.quote_number, result.processed_text),
  );

// New mail: replaces the n8n Gmail Trigger. A message is "new" until it carries one of our four labels,
// so mail that arrived while the worker was down is picked up on the next start.
export async function runFreshPass(since, shouldStop = () => false) {
  const query = `after:${Math.floor(since.getTime() / 1000)} ${config.gmail.query}`.trim();
  const ids = await gmail.listMessageIds(query);
  const stats = { processed: 0, failed: 0 };

  for (const id of ids) {
    if (shouldStop()) break;
    try {
      if (hasAny(await gmail.getLabelIds(id), ALL_LABELS)) continue;
      await processFresh(id);
      stats.processed++;
    } catch (error) {
      // Gmail or Supabase is unavailable: leave the message unlabeled so the next pass retries it.
      log.error(`fresh ${id}: failed`, error);
      stats.failed++;
    }
  }
  return stats;
}

async function processFresh(id) {
  const message = await gmail.getRawMessage(id);

  // An email that cannot be parsed is handled like an AI failure,
  // so it ends up in the retry queue instead of blocking the fresh pass.
  let email = { subject: '' };
  let result;
  try {
    email = await parseEmail(message.raw);
    result = await extractQuote(email, freshChain);
  } catch (error) {
    log.warn(`fresh ${id}: AI failed, queued for retry`, error);
    await recordMissed(id, email.subject, 'no gemini');
    await setLabels(id, { add: [labels.aiError] });
    return;
  }

  if (!isSuccess(result)) {
    log.info(`fresh ${id}: ${result.status} "${email.subject}"`);
    await setLabels(id, { add: [labels.noQuote] });
    return;
  }

  try {
    await postComment(result);
  } catch (error) {
    log.warn(`fresh ${id}: Bitrix failed for quote ${result.quote_number}, queued for retry`, error);
    await recordMissed(id, email.subject, 'no bitrix');
    await setLabels(id, { add: [labels.bitrixError] });
    return;
  }

  log.info(`fresh ${id}: comment added to quote ${result.quote_number} "${email.subject}"`);
  await setLabels(id, { add: [labels.ok] });
}

// Replaces the "auxiliary" workflow: reprocesses rows of missed_messages with the stronger model
// and the OpenAI fallback. AI failures stay queued; everything else is retried once.
export async function runRetryPass(shouldStop = () => false) {
  const rows = await supabase.listPending();
  for (const row of rows) {
    if (shouldStop()) break;
    try {
      await processRetry(row);
    } catch (error) {
      log.error(`retry ${row.message_id}: failed`, error);
    }
  }
  return rows.length;
}

async function processRetry(row) {
  const id = row.message_id;
  const done = () => write(`missed_messages #${row.id} reprocessing=true`, () => supabase.markReprocessed(row.id));

  let message;
  try {
    message = await gmail.getRawMessage(id);
  } catch (error) {
    if (error.status !== 404) throw error;
    log.warn(`retry ${id}: message no longer exists, dropping`);
    await done();
    return;
  }

  // Finished by the fresh pass in the meantime (e.g. a label write had failed earlier).
  if (hasAny(message.labelIds, FINAL_LABELS) && !hasAny(message.labelIds, ERROR_LABELS)) {
    await done();
    return;
  }

  let email, result;
  try {
    email = await parseEmail(message.raw);
    result = await extractQuote(email, retryChain);
  } catch (error) {
    log.warn(`retry ${id}: AI failed again, will retry later`, error);
    await setLabels(id, { add: [labels.aiError] });
    return;
  }

  if (!isSuccess(result)) {
    log.info(`retry ${id}: ${result.status} "${email.subject}"`);
    await setLabels(id, { add: [labels.noQuote], remove: ERROR_LABELS });
    await done();
    return;
  }

  try {
    await postComment(result);
  } catch (error) {
    log.warn(`retry ${id}: Bitrix failed again for quote ${result.quote_number}, giving up`, error);
    await setLabels(id, { add: [labels.bitrixError], remove: [labels.aiError] });
    await done();
    return;
  }

  log.info(`retry ${id}: comment added to quote ${result.quote_number} "${email.subject}"`);
  await setLabels(id, { add: [labels.ok], remove: ERROR_LABELS });
  await done();
}
