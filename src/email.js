import { simpleParser } from 'mailparser';
import { NodeHtmlMarkdown } from 'node-html-markdown';

// Same HTML-to-Markdown library as the n8n Markdown node, so the AI sees the same text as before.
// Plain-text emails (no HTML part) fall back to the text body.
export async function parseEmail(raw) {
  const mail = await simpleParser(raw);
  const text = typeof mail.html === 'string' ? NodeHtmlMarkdown.translate(mail.html) : mail.text ?? '';
  return { subject: mail.subject ?? '', text };
}
