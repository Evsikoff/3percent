// Fake configuration; imported before any src module so config.js sees it.
Object.assign(process.env, {
  GMAIL_CLIENT_ID: 'client-id',
  GMAIL_CLIENT_SECRET: 'client-secret',
  GMAIL_REFRESH_TOKEN: 'refresh-token',
  GEMINI_API_KEY: 'gemini-key',
  OPENAI_API_KEY: 'openai-key',
  BITRIX_WEBHOOK_URL: 'https://b24.example.ru/rest/1/token/',
  SUPABASE_URL: 'https://sb.example.co',
  SUPABASE_KEY: 'supabase-key',
});
for (const name of ['DRY_RUN', 'GEMINI_BASE_URL', 'OPENAI_BASE_URL', 'GMAIL_QUERY', 'PROCESS_AFTER']) {
  delete process.env[name];
}
