import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';

const { parseAiJson, normalizeResult } = await import('../src/ai.js');
const { parseEmail } = await import('../src/email.js');
const { buildPrompt } = await import('../src/prompt.js');

test('parses JSON wrapped in a code fence', () => {
  const parsed = parseAiJson('```json\n{"quote_number":"7356","status":"SUCCESS","processed_text":"a"}\n```');
  assert.deepEqual(parsed, { quote_number: '7356', status: 'SUCCESS', processed_text: 'a' });
});

test('repairs a truncated JSON response', () => {
  const parsed = parseAiJson('{"quote_number":"7356","status":"SUCCESS","processed_text":"FOB 9270.00 USD');
  assert.equal(parsed.processed_text, 'FOB 9270.00 USD');
});

test('rejects a response without required fields', () => {
  assert.throws(() => normalizeResult({ status: 'SUCCESS' }), /missing required field: quote_number/);
});

test('normalizes numbers and whitespace like the n8n parser', () => {
  assert.deepEqual(normalizeResult({ quote_number: 7356, status: ' SUCCESS ', processed_text: null }), {
    quote_number: '7356',
    status: 'SUCCESS',
    processed_text: null,
  });
});

test('prompt ends with the email, defaults and 12000-char limit as in n8n', () => {
  const prompt = buildPrompt('', 'x'.repeat(13_000));
  assert.match(prompt, /Тема письма: \(без темы\)\nТекст письма:\nx{12000}$/);
  assert.match(buildPrompt('S', ''), /Текст письма:\nТекст отсутствует$/);
});

function mime(contentType, body) {
  return Buffer.concat([
    Buffer.from(`From: a@example.com\r\nSubject: Re: Quote #1\r\nMIME-Version: 1.0\r\nContent-Type: ${contentType}\r\n\r\n`),
    body,
  ]);
}

test('decodes legacy charsets used by Chinese and Russian senders', async () => {
  const chinese = await parseEmail(mime('text/plain; charset=gb2312', iconv.encode('运费 USD9000', 'gb2312')));
  assert.equal(chinese.text.trim(), '运费 USD9000');
  const russian = await parseEmail(mime('text/plain; charset=koi8-r', iconv.encode('Фрахт 2678 USD', 'koi8-r')));
  assert.equal(russian.text.trim(), 'Фрахт 2678 USD');
});

test('converts HTML to Markdown', async () => {
  const email = await parseEmail(mime('text/html; charset=utf-8', Buffer.from('<p>FOB <b>USD9000</b></p><div>ETD:26-07</div>')));
  assert.equal(email.subject, 'Re: Quote #1');
  assert.equal(email.text, 'FOB **USD9000**\n\nETD:26-07');
});
