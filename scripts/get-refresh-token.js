// One-off helper: obtains a Gmail refresh token for GMAIL_REFRESH_TOKEN.
// Needs an OAuth client of type "Desktop app" (loopback redirects are allowed for it).
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
let redirectUri;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/' || url.searchParams.get('state') !== state) {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    res.end(`Authorization failed: ${url.searchParams.get('error')}`);
    console.error(`Authorization failed: ${url.searchParams.get('error')}`);
    server.close();
    return;
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await response.json();

  if (!data.refresh_token) {
    res.end('No refresh token received, see the terminal.');
    console.error('No refresh token in the response:', data.error ?? data);
  } else {
    res.end('Done. Return to the terminal.');
    console.log('\nGMAIL_REFRESH_TOKEN=' + data.refresh_token + '\n');
  }
  server.close();
});

server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  console.log('Open this URL and sign in with the mailbox the worker should read:\n');
  console.log(`https://accounts.google.com/o/oauth2/v2/auth?${params}\n`);
});
