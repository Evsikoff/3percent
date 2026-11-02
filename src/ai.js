import { config } from './config.js';
import { requestJson } from './http.js';
import { buildPrompt } from './prompt.js';
import { log } from './log.js';

const STATUSES = ['SUCCESS', 'NO_QUOTE_NUMBER', 'NOT_FOUND'];

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    quote_number: { type: 'STRING', nullable: true },
    status: { type: 'STRING', enum: STATUSES },
    processed_text: { type: 'STRING', nullable: true },
  },
  propertyOrdering: ['quote_number', 'status', 'processed_text'],
  required: ['quote_number', 'status', 'processed_text'],
};

const OPENAI_SCHEMA = {
  type: 'object',
  properties: {
    quote_number: { type: ['string', 'null'] },
    status: { type: 'string', enum: STATUSES },
    processed_text: { type: ['string', 'null'] },
  },
  required: ['quote_number', 'status', 'processed_text'],
  additionalProperties: false,
};

async function askGemini(model, prompt) {
  const data = await requestJson('Gemini', `${config.gemini.baseUrl}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0,
        thinkingConfig: { thinkingLevel: 'low' },
        responseSchema: GEMINI_SCHEMA,
      },
    }),
    timeoutMs: 180_000,
    retry: true,
  });
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts.find((part) => typeof part?.text === 'string' && !part.thought)?.text;
}

// No temperature: GPT-5 models reject anything but the default.
async function askOpenAI(model, prompt) {
  const data = await requestJson('OpenAI', `${config.openai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openai.apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'quote', strict: true, schema: OPENAI_SCHEMA } },
    }),
    timeoutMs: 180_000,
    retry: true,
  });
  return data?.choices?.[0]?.message?.content;
}

const PROVIDERS = { gemini: askGemini, openai: askOpenAI };

// Ported from the "Parse Gemini JSON" code node: strips code fences and closes truncated JSON.
export function parseAiJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('AI response does not contain JSON text');
  }

  let cleaned = text
    .trim()
    .replace(/^﻿/, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) throw new Error('AI response does not contain the beginning of a JSON object');
  cleaned = cleaned.slice(firstBrace).trim();

  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace !== -1) {
    try {
      return JSON.parse(cleaned.slice(0, lastBrace + 1));
    } catch {
      // Continue to conservative repair below.
    }
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    const expectedClosers = [];
    let inString = false;
    let escaped = false;

    for (const char of cleaned) {
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') expectedClosers.push('}');
      else if (char === '[') expectedClosers.push(']');
      else if (expectedClosers.length > 0 && char === expectedClosers[expectedClosers.length - 1]) {
        expectedClosers.pop();
      }
    }

    let repaired = cleaned.trimEnd();
    if (inString) {
      if (escaped) repaired += '\\';
      repaired += '"';
    } else {
      repaired = repaired.replace(/,\s*$/, '');
    }
    repaired += expectedClosers.reverse().join('');

    try {
      return JSON.parse(repaired);
    } catch (repairError) {
      throw new Error(`AI response contains invalid JSON and automatic repair failed: ${repairError.message}`);
    }
  }
}

export function normalizeResult(parsed) {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Parsed AI response is not an object');
  }
  for (const field of ['quote_number', 'status', 'processed_text']) {
    if (!Object.hasOwn(parsed, field)) throw new Error(`AI response is missing required field: ${field}`);
  }
  return {
    quote_number: parsed.quote_number === null ? null : String(parsed.quote_number).trim(),
    status: parsed.status === null ? null : String(parsed.status).trim(),
    processed_text: parsed.processed_text === null ? null : String(parsed.processed_text),
  };
}

// Tries each { provider, model } in turn; throws only if all of them fail.
export async function extractQuote({ subject, text }, chain) {
  const prompt = buildPrompt(subject, text);
  let lastError;
  for (const { provider, model } of chain) {
    try {
      return normalizeResult(parseAiJson(await PROVIDERS[provider](model, prompt)));
    } catch (error) {
      log.warn(`${provider}/${model} failed`, error);
      lastError = error;
    }
  }
  throw lastError ?? new Error('No AI providers configured');
}

export const freshChain = [{ provider: 'gemini', model: config.gemini.model }];

export const retryChain = [
  { provider: 'gemini', model: config.gemini.retryModel },
  ...(config.openai.apiKey ? [{ provider: 'openai', model: config.openai.model }] : []),
];
