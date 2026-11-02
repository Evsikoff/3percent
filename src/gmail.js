import { config } from './config.js';
import { requestJson } from './http.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
let token = null;

async function accessToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const data = await requestJson('Google OAuth', 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.gmail.clientId,
      client_secret: config.gmail.clientSecret,
      refresh_token: config.gmail.refreshToken,
      grant_type: 'refresh_token',
    }),
    retry: true,
  });
  token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return token.value;
}

async function gmail(path, { method = 'GET', body } = {}) {
  const headers = { authorization: `Bearer ${await accessToken()}` };
  if (body) headers['content-type'] = 'application/json';
  return requestJson('Gmail', `${API}${path}`, {
    method,
    headers,
    body: body && JSON.stringify(body),
    retry: true,
  });
}

// Oldest first, so a backlog is processed in the order it arrived.
export async function listMessageIds(query) {
  const ids = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ q: query, maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await gmail(`/messages?${params}`);
    for (const message of page.messages ?? []) ids.push(message.id);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids.reverse();
}

export async function getLabelIds(id) {
  const message = await gmail(`/messages/${id}?format=minimal`);
  return message.labelIds ?? [];
}

// Raw RFC 822 source: mailparser then handles charsets (GB2312, KOI8-R, ...) and transfer encodings.
export async function getRawMessage(id) {
  const message = await gmail(`/messages/${id}?format=raw`);
  return { id: message.id, labelIds: message.labelIds ?? [], raw: Buffer.from(message.raw, 'base64url') };
}

export async function modifyLabels(id, { add = [], remove = [] }) {
  await gmail(`/messages/${id}/modify`, {
    method: 'POST',
    body: { addLabelIds: add, removeLabelIds: remove },
  });
}

export async function getLabel(id) {
  return gmail(`/labels/${id}`);
}
