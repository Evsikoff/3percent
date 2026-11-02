import { config } from './config.js';
import * as bitrix from './bitrix.js';
import * as gmail from './gmail.js';
import { requestJson } from './http.js';
import { log } from './log.js';
import * as supabase from './supabase.js';

function geminiModel(model) {
  return requestJson('Gemini', `${config.gemini.baseUrl}/v1beta/models/${model}`, {
    headers: { 'x-goog-api-key': config.gemini.apiKey },
  });
}

function openaiModel(model) {
  return requestJson('OpenAI', `${config.openai.baseUrl}/models/${model}`, {
    headers: { authorization: `Bearer ${config.openai.apiKey}` },
  });
}

const BITRIX_HINT =
  'If this is a timeout or connection reset, Bitrix may be refusing connections from outside Russia: ' +
  'point BITRIX_WEBHOOK_URL at a relay hosted in Russia.';

// Each check: [name, run, required]. Required failures stop the worker before it touches any mail.
function checks() {
  const list = [
    ...Object.entries(config.labels).map(([role, id]) => [
      `Gmail label ${role} (${id})`,
      async () => `"${(await gmail.getLabel(id)).name}"`,
      true,
    ]),
    ['Supabase table', () => supabase.checkAccess().then(() => config.supabase.table), true],
    [`Gemini model ${config.gemini.model}`, () => geminiModel(config.gemini.model).then(() => 'available'), true],
    [`Gemini retry model ${config.gemini.retryModel}`, () => geminiModel(config.gemini.retryModel).then(() => 'available'), false],
    ['Bitrix webhook', () => bitrix.checkAccess().then(() => 'reachable'), true],
  ];
  if (config.openai.apiKey) {
    list.push([`OpenAI model ${config.openai.model}`, () => openaiModel(config.openai.model).then(() => 'available'), false]);
  } else {
    log.warn('OPENAI_API_KEY is not set: retries will use Gemini only');
  }
  return list;
}

export async function runChecks() {
  let fatal = 0;
  for (const [name, run, required] of checks()) {
    try {
      log.info(`check ${name}: OK ${await run()}`);
    } catch (error) {
      const hint = name === 'Bitrix webhook' ? ` ${BITRIX_HINT}` : '';
      if (required) {
        fatal++;
        log.error(`check ${name}: FAILED${hint}`, error);
      } else {
        log.warn(`check ${name}: FAILED (optional)`, error);
      }
    }
  }
  if (fatal) throw new Error(`${fatal} required check(s) failed`);
}
