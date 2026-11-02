const env = process.env;

function required(name) {
  const value = env[name];
  if (!value) throw new Error(`Environment variable ${name} is not set`);
  return value;
}

function number(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function date(name) {
  const raw = env[name];
  if (!raw) return null;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) throw new Error(`${name} must be a date like 2026-10-25`);
  return value;
}

const trimSlash = (url) => url.replace(/\/+$/, '');

export const config = {
  gmail: {
    clientId: required('GMAIL_CLIENT_ID'),
    clientSecret: required('GMAIL_CLIENT_SECRET'),
    refreshToken: required('GMAIL_REFRESH_TOKEN'),
    // Incoming mail only: sent messages contain our own prices and must not reach Bitrix.
    query: env.GMAIL_QUERY ?? '-in:sent -in:draft -in:chats',
  },
  // Label IDs from the original n8n workflow (Gmail account "Gmail Benefit").
  labels: {
    ok: env.LABEL_OK || 'Label_904891371254780187',
    noQuote: env.LABEL_NO_QUOTE || 'Label_4180071384748807826',
    bitrixError: env.LABEL_BITRIX_ERROR || 'Label_7629150265200231247',
    aiError: env.LABEL_AI_ERROR || 'Label_846358029050760511',
  },
  gemini: {
    apiKey: required('GEMINI_API_KEY'),
    baseUrl: trimSlash(env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'),
    model: env.GEMINI_MODEL || 'gemini-3.5-flash',
    retryModel: env.GEMINI_RETRY_MODEL || 'gemini-3.1-pro-preview',
  },
  openai: {
    apiKey: env.OPENAI_API_KEY || '',
    baseUrl: trimSlash(env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
    model: env.OPENAI_MODEL || 'gpt-5.2',
  },
  bitrix: {
    webhookUrl: trimSlash(required('BITRIX_WEBHOOK_URL')),
    entityType: env.BITRIX_ENTITY_TYPE || 'quote',
    authorId: env.BITRIX_AUTHOR_ID || '66',
  },
  supabase: {
    url: trimSlash(required('SUPABASE_URL')),
    key: required('SUPABASE_KEY'),
    table: env.SUPABASE_TABLE || 'missed_messages',
  },
  pollIntervalSec: number('POLL_INTERVAL_SEC', 60),
  retryIntervalMin: number('RETRY_INTERVAL_MIN', 10),
  processAfter: date('PROCESS_AFTER'),
  startupLookbackHours: number('STARTUP_LOOKBACK_HOURS', 24),
  dryRun: ['1', 'true', 'yes'].includes(String(env.DRY_RUN ?? '').toLowerCase()),
};
