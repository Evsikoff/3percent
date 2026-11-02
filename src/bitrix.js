import { config } from './config.js';
import { requestJson } from './http.js';

async function call(method, params) {
  const data = await requestJson('Bitrix', `${config.bitrix.webhookUrl}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (data.error) throw new Error(`Bitrix: ${data.error}: ${data.error_description ?? ''}`);
  return data.result;
}

// Not retried automatically: a timeout after Bitrix saved the comment would post it twice.
export function addQuoteComment(quoteNumber, comment) {
  return call('crm.timeline.comment.add', {
    'fields[ENTITY_ID]': quoteNumber,
    'fields[ENTITY_TYPE]': config.bitrix.entityType,
    'fields[COMMENT]': comment,
    'fields[AUTHOR_ID]': config.bitrix.authorId,
  });
}

// Read-only call used by the startup check.
export function checkAccess() {
  return call('crm.quote.fields', {});
}
