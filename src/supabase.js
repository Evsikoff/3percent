import { config } from './config.js';
import { requestJson } from './http.js';

const tableUrl = `${config.supabase.url}/rest/v1/${config.supabase.table}`;

function headers(extra = {}) {
  return {
    apikey: config.supabase.key,
    authorization: `Bearer ${config.supabase.key}`,
    'content-type': 'application/json',
    ...extra,
  };
}

// `reprocessing` is written as the strings "false"/"true", exactly like the n8n Supabase node did,
// so it works whether the column is text or boolean.
export async function insertMissed({ messageId, subject, error }) {
  await requestJson('Supabase', tableUrl, {
    method: 'POST',
    headers: headers({ prefer: 'return=minimal' }),
    body: JSON.stringify({ message_id: messageId, subject, reprocessing: 'false', error }),
  });
}

export async function listPending(limit = 50) {
  const params = new URLSearchParams({
    select: 'id,message_id,subject,error',
    reprocessing: 'eq.false',
    order: 'id.asc',
    limit: String(limit),
  });
  return requestJson('Supabase', `${tableUrl}?${params}`, { headers: headers(), retry: true });
}

export async function markReprocessed(id) {
  await requestJson('Supabase', `${tableUrl}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: headers({ prefer: 'return=minimal' }),
    body: JSON.stringify({ reprocessing: 'true' }),
    retry: true,
  });
}

export async function checkAccess() {
  return requestJson('Supabase', `${tableUrl}?select=id&limit=1`, { headers: headers() });
}
