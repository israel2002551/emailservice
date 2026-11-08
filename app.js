// The BUYSELL email service's HTTP API: POST /api/send-email and GET /health.
// Only trusted BUYSELL servers (the send-broadcast Edge Function) call it, with
// the shared secret in "Authorization: Bearer <EMAIL_SERVICE_SECRET>". It is
// never called from the browser, so it sends no CORS headers.
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';

// SendGrid takes up to 1,000 recipients ("personalizations") in one request.
export const MAX_RECIPIENTS = 1000;
export const MAX_SUBJECT_LENGTH = 255;
const BODY_LIMIT = '1mb';
// A practical address check: something@domain.tld, with no spaces or brackets.
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]{2,}$/;

const digest = (value) => createHash('sha256').update(String(value)).digest();

// Compares hashes so the check takes the same time whatever the token is.
function hasServiceToken(header, secret) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
  return match !== null && timingSafeEqual(digest(match[1]), digest(secret));
}

const isFilled = (value) => typeof value === 'string' && value.trim() !== '';

// Checks a request body. Returns { message } ready to send, or { error, ... } for a 400.
export function readEmailRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Send a JSON object with to, subject and text.', missing: ['to', 'subject', 'text'] };
  }
  const { to, subject, text, html } = body;

  const missing = [];
  if (Array.isArray(to) ? to.length === 0 : !isFilled(to)) missing.push('to');
  if (!isFilled(subject)) missing.push('subject');
  if (!isFilled(text)) missing.push('text');
  if (missing.length) {
    return { error: `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`, missing };
  }

  const list = Array.isArray(to) ? to : [to];
  if (list.some((item) => typeof item !== 'string')) {
    return { error: 'to must be an email address or a list of email addresses.' };
  }
  const recipients = [];
  const seen = new Set();
  for (const item of list) {
    const email = item.trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    recipients.push(email);
  }
  if (!recipients.length) return { error: 'Missing required field: to.', missing: ['to'] };
  if (recipients.length > MAX_RECIPIENTS) {
    return { error: `Send to at most ${MAX_RECIPIENTS} recipients per request, and split bigger lists into batches.` };
  }
  const invalid = recipients.filter((email) => email.length > 254 || !EMAIL_PATTERN.test(email));
  if (invalid.length) {
    return {
      error: invalid.length === 1 ? '1 recipient address is not valid.' : `${invalid.length} recipient addresses are not valid.`,
      invalid: invalid.slice(0, 20),
    };
  }

  if (/[\r\n]/.test(subject)) return { error: 'subject must be a single line.' };
  if (subject.trim().length > MAX_SUBJECT_LENGTH) {
    return { error: `subject must be ${MAX_SUBJECT_LENGTH} characters or fewer.` };
  }
  if (html !== undefined && html !== null && typeof html !== 'string') {
    return { error: 'html must be a string when provided.' };
  }

  return { message: { to: recipients, subject: subject.trim(), text, html: isFilled(html) ? html : undefined } };
}

/**
 * Builds the Express app.
 * @param {object} options
 * @param {(mail: object, isMultiple: boolean) => Promise<any>} options.sendMail sends through SendGrid
 * @param {string} options.from the verified sender, e.g. "BUYSELL Nigeria <info@buysell-marketplace.com>"
 * @param {string} options.secret the shared secret callers must send
 * @param {{ log: Function, error: Function }} [options.logger]
 */
export function createApp({ sendMail, from, secret, logger = console }) {
  if (typeof sendMail !== 'function' || !from || !secret) {
    throw new Error('createApp needs sendMail, from and secret.');
  }

  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post(
    '/api/send-email',
    // The secret is checked before the body is read, so strangers cost almost nothing.
    (req, res, next) => {
      if (hasServiceToken(req.get('authorization'), secret)) return next();
      return res.status(401).json({ success: false, error: 'Missing or wrong service token.' });
    },
    express.json({ limit: BODY_LIMIT }),
    async (req, res) => {
      const request = readEmailRequest(req.body);
      if (request.error) {
        const { error, ...details } = request;
        return res.status(400).json({ success: false, error, ...details });
      }

      const { to, subject, text, html } = request.message;
      const mail = { from, to: to.length === 1 ? to[0] : to, subject, text, ...(html ? { html } : {}) };
      try {
        // isMultiple: each recipient gets their own copy and never sees the other addresses.
        const [response] = await sendMail(mail, to.length > 1);
        logger.log(`Sent "${subject}" to ${to.length} recipient(s); SendGrid answered ${response?.statusCode ?? 'with no status'}.`);
        return res.status(200).json({
          success: true,
          message: `SendGrid accepted the email for ${to.length} recipient${to.length === 1 ? '' : 's'}.`,
          recipients: to.length,
          message_id: response?.headers?.['x-message-id'] ?? null,
        });
      } catch (error) {
        // SendGrid errors carry the HTTP status in `code` and the reasons in the response body.
        const status = Number(error?.code) || null;
        const details = (error?.response?.body?.errors ?? []).map((item) => item?.message).filter(Boolean);
        if (!details.length) details.push(String(error?.message || 'Unknown error'));
        logger.error(`SendGrid send failed${status ? ` (${status})` : ''}: ${details.join('; ')}`);
        return res.status(500).json({
          success: false,
          error: 'SendGrid could not send the email.',
          sendgrid_status: status,
          details,
        });
      }
    },
  );

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'Not found.' });
  });

  // Express needs all four arguments to treat this as the error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, error: 'The request body must be valid JSON.' });
    }
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ success: false, error: 'The request body is larger than 1 MB.' });
    }
    logger.error('Unexpected error:', error);
    return res.status(500).json({ success: false, error: 'Unexpected server error.' });
  });

  return app;
}
