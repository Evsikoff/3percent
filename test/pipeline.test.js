import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { retryPolicy } = await import('../src/http.js');
const { runFreshPass, runRetryPass } = await import('../src/pipeline.js');
retryPolicy.delaysMs = [0, 0];

const L = {
  ok: 'Label_904891371254780187',
  noQuote: 'Label_4180071384748807826',
  bitrixError: 'Label_7629150265200231247',
  aiError: 'Label_846358029050760511',
};

// ---- fake outside world -------------------------------------------------

const mailbox = new Map();
const rows = [];
const comments = [];
const gmailQueries = [];
const rawFetches = [];

function addMail(id, subject, { html, text, labels = [] }) {
  const body = html
    ? `Content-Type: text/html; charset=utf-8\r\n\r\n${html}`
    : `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}`;
  const raw = Buffer.from(`From: carrier@example.com\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\n${body}`);
  mailbox.set(id, { labels: new Set(labels), raw: raw.toString('base64url') });
}

const labelsOf = (id) => [...mailbox.get(id).labels].sort();

// Answers depend on the quote number in the email (the prompt examples are skipped).
function aiAnswer(prompt, provider, model) {
  const input = prompt.split('ВХОДНЫЕ ДАННЫЕ')[1];
  const quote = input.match(/Quote #(\d+)/)?.[1];
  if (!quote) return { quote_number: null, status: 'NOT_FOUND', processed_text: null };
  if (quote === '4444') return null; // fails everywhere
  if (quote === '5555' && model === 'gemini-3.5-flash') return null; // only the retry model works
  assert.ok(!input.includes('<p>'), 'HTML must be converted before reaching the AI');
  return { quote_number: quote, status: 'SUCCESS', processed_text: `${provider}: ${input.match(/USD\d+/)?.[0]} +3%` };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  const method = init.method ?? 'GET';

  switch (url.host) {
    case 'oauth2.googleapis.com':
      return json({ access_token: 'access', expires_in: 3600 });

    case 'gmail.googleapis.com': {
      if (url.pathname.endsWith('/messages')) {
        gmailQueries.push(url.searchParams.get('q'));
        return json({ messages: [...mailbox.keys()].reverse().map((id) => ({ id })) });
      }
      const [, id, modify] = url.pathname.match(/\/messages\/([^/]+)(\/modify)?$/);
      const message = mailbox.get(id);
      if (!message) return json({ error: { code: 404 } }, 404);
      if (modify) {
        const { addLabelIds, removeLabelIds } = JSON.parse(init.body);
        addLabelIds.forEach((label) => message.labels.add(label));
        removeLabelIds.forEach((label) => message.labels.delete(label));
        return json({});
      }
      const format = url.searchParams.get('format');
      if (format === 'raw') rawFetches.push(id);
      return json({ id, labelIds: [...message.labels], ...(format === 'raw' && { raw: message.raw }) });
    }

    case 'generativelanguage.googleapis.com': {
      assert.equal(init.headers['x-goog-api-key'], 'gemini-key');
      const model = url.pathname.match(/models\/([^:]+):generateContent$/)[1];
      const answer = aiAnswer(JSON.parse(init.body).contents[0].parts[0].text, 'gemini', model);
      if (!answer) return json({ error: { message: 'overloaded' } }, 503);
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
    }

    case 'api.openai.com': {
      const body = JSON.parse(init.body);
      const answer = aiAnswer(body.messages[0].content, 'openai', body.model);
      if (!answer) return json({ error: { message: 'server error' } }, 500);
      return json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
    }

    case 'b24.example.ru': {
      assert.equal(url.pathname, '/rest/1/token/crm.timeline.comment.add');
      const form = new URLSearchParams(init.body);
      if (form.get('fields[ENTITY_ID]') === '9999') {
        return json({ error: 'NOT_FOUND', error_description: 'Not found' }, 400);
      }
      comments.push({
        quote: form.get('fields[ENTITY_ID]'),
        type: form.get('fields[ENTITY_TYPE]'),
        author: form.get('fields[AUTHOR_ID]'),
        comment: form.get('fields[COMMENT]'),
      });
      return json({ result: comments.length });
    }

    case 'sb.example.co': {
      if (method === 'POST') {
        rows.push({ id: rows.length + 1, ...JSON.parse(init.body) });
        return new Response(null, { status: 201 });
      }
      if (method === 'PATCH') {
        const id = Number(url.searchParams.get('id').replace('eq.', ''));
        Object.assign(rows.find((row) => row.id === id), JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      return json(rows.filter((row) => row.reprocessing === 'false'));
    }
  }
  throw new Error(`unexpected request to ${url}`);
};

// ---- scenario -------------------------------------------------------------

addMail('done', 'Re: Quote #8100', { html: '<p>USD1</p>', labels: [L.ok] });
addMail('ok', 'Re: Quote #8101', { html: '<p>FOB Ningbo <b>USD9000</b></p>' });
addMail('newsletter', 'Newsletter', { html: '<p>Hello</p>' });
addMail('bitrix-down', 'Re: Quote #9999', { html: '<p>USD100</p>' });
addMail('flash-down', 'Re: Quote #5555', { html: '<p>USD500</p>' });
addMail('ai-down', 'Re: Quote #4444', { text: 'USD444 plain text' });

test('fresh pass labels every new message and posts quotes to Bitrix', async () => {
  const stats = await runFreshPass(new Date('2026-11-01T00:00:00Z'));

  assert.deepEqual(stats, { processed: 5, failed: 0 });
  assert.equal(gmailQueries[0], 'after:1793491200 -in:sent -in:draft -in:chats');
  assert.ok(!rawFetches.includes('done'), 'already labeled mail is not downloaded');
  assert.equal(rawFetches[0], 'ok', 'oldest mail first');

  assert.deepEqual(comments, [{ quote: '8101', type: 'quote', author: '66', comment: 'gemini: USD9000 +3%' }]);
  assert.deepEqual(labelsOf('ok'), [L.ok]);
  assert.deepEqual(labelsOf('newsletter'), [L.noQuote]);
  assert.deepEqual(labelsOf('bitrix-down'), [L.bitrixError]);
  assert.deepEqual(labelsOf('flash-down'), [L.aiError]);
  assert.deepEqual(labelsOf('ai-down'), [L.aiError]);

  assert.deepEqual(
    rows.map(({ message_id, subject, error, reprocessing }) => [message_id, subject, error, reprocessing]),
    [
      ['bitrix-down', 'Re: Quote #9999', 'no bitrix', 'false'],
      ['flash-down', 'Re: Quote #5555', 'no gemini', 'false'],
      ['ai-down', 'Re: Quote #4444', 'no gemini', 'false'],
    ],
  );
});

test('retry pass reprocesses the queue like the auxiliary workflow', async () => {
  rows.push({ id: rows.length + 1, message_id: 'deleted', subject: 'gone', error: 'no gemini', reprocessing: 'false' });

  await runRetryPass();

  // Retry model succeeds -> comment posted, error labels cleared.
  assert.deepEqual(comments.at(-1), { quote: '5555', type: 'quote', author: '66', comment: 'gemini: USD500 +3%' });
  assert.deepEqual(labelsOf('flash-down'), [L.ok]);
  // Bitrix still failing -> given up after one retry.
  assert.deepEqual(labelsOf('bitrix-down'), [L.bitrixError]);
  // Gemini and OpenAI both down -> stays queued.
  assert.deepEqual(labelsOf('ai-down'), [L.aiError]);

  const state = Object.fromEntries(rows.map((row) => [row.message_id, row.reprocessing]));
  assert.deepEqual(state, { 'bitrix-down': 'true', 'flash-down': 'true', 'ai-down': 'false', deleted: 'true' });
});

test('a second fresh pass touches nothing', async () => {
  const before = comments.length;
  const stats = await runFreshPass(new Date('2026-11-01T00:00:00Z'));
  assert.deepEqual(stats, { processed: 0, failed: 0 });
  assert.equal(comments.length, before);
});

test('when OpenAI is the only working model, retries use it', async () => {
  addMail('openai-only', 'Re: Quote #4444', { text: 'USD444' });
  const quote = mailbox.get('openai-only');
  quote.labels.add(L.aiError);
  rows.push({ id: rows.length + 1, message_id: 'openai-only', subject: 'x', error: 'no gemini', reprocessing: 'false' });

  // OpenAI recovers while Gemini keeps failing for quote 4444.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (new URL(input).host === 'api.openai.com') {
      const body = JSON.parse(init.body);
      const answer = { quote_number: '4444', status: 'SUCCESS', processed_text: `openai via ${body.model}` };
      return json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
    }
    return realFetch(input, init);
  };
  try {
    await runRetryPass();
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(comments.at(-1).comment, 'openai via gpt-5.2');
  assert.deepEqual(labelsOf('openai-only'), [L.ok]);
});
