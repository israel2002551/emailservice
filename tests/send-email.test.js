// POST /api/send-email and GET /health, with SendGrid replaced by a recorder.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, MAX_RECIPIENTS } from '../app.js';

const SECRET = 'test-secret-that-is-long-enough-0123456789';
const FROM = 'BUYSELL Nigeria <info@buysell-marketplace.com>';
const quiet = { log() {}, error() {} };

let server;
let base;
let calls;
let outcome;

before(async () => {
  const app = createApp({
    from: FROM,
    secret: SECRET,
    logger: quiet,
    sendMail: async (mail, isMultiple) => {
      calls.push({ mail, isMultiple });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  calls = [];
  outcome = [{ statusCode: 202, headers: { 'x-message-id': 'msg-123' } }, ''];
});

async function post(body, { token = SECRET, raw } = {}) {
  const res = await fetch(`${base}/api/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const email = { to: 'ada@gmail.com', subject: 'Your order is on its way', text: 'Hello Ada' };

test('GET /health answers 200', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('a request without the secret is refused before anything is read', async () => {
  const res = await post(email, { token: '' });
  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
  assert.equal(calls.length, 0);
});

test('a wrong secret is refused, even with a broken body', async () => {
  const res = await post(null, { token: 'not-the-secret', raw: '{oops' });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('missing fields are named in a 400', async () => {
  let res = await post({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.missing, ['to', 'subject', 'text']);
  assert.match(res.body.error, /Missing required fields: to, subject, text/);

  res = await post({ to: 'ada@gmail.com', text: 'Hi' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.missing, ['subject']);

  res = await post({ ...email, to: ['  ', ''] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.missing, ['to']);
  assert.equal(calls.length, 0);
});

test('a body that is not JSON gets a 400', async () => {
  const res = await post(null, { raw: '{"to": "ada@gmail.com",' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /valid JSON/);
});

test('bad addresses, oversized lists and bad fields get a 400', async () => {
  let res = await post({ ...email, to: ['ada@gmail.com', 'not-an-email', 'a@b, c@d.com'] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.invalid, ['not-an-email', 'a@b, c@d.com']);

  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `user${i}@gmail.com`);
  res = await post({ ...email, to: many });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at most 1000 recipients/);

  res = await post({ ...email, to: [42] });
  assert.equal(res.status, 400);

  res = await post({ ...email, subject: 'Hello\r\nBcc: someone@evil.com' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /single line/);

  res = await post({ ...email, html: { tag: 'p' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /html must be a string/);
  assert.equal(calls.length, 0);
});

test('one recipient: SendGrid gets the verified sender and the message', async () => {
  const res = await post(email);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    success: true,
    message: 'SendGrid accepted the email for 1 recipient.',
    recipients: 1,
    message_id: 'msg-123',
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].mail, { from: FROM, to: 'ada@gmail.com', subject: 'Your order is on its way', text: 'Hello Ada' });
  assert.equal(calls[0].isMultiple, false);
});

test('several recipients each get their own copy, with duplicates dropped', async () => {
  const res = await post({ ...email, to: ['ada@gmail.com', ' bayo@yahoo.com ', 'ADA@gmail.com'], html: '<p>Hello</p>' });
  assert.equal(res.status, 200);
  assert.equal(res.body.recipients, 2);
  assert.deepEqual(calls[0].mail.to, ['ada@gmail.com', 'bayo@yahoo.com']);
  assert.equal(calls[0].mail.html, '<p>Hello</p>');
  assert.equal(calls[0].isMultiple, true, 'recipients must not see each other');
});

test('callers cannot change the sender', async () => {
  await post({ ...email, from: 'ceo@bank.com' });
  assert.equal(calls[0].mail.from, FROM);
});

test('a SendGrid refusal is a 500 with SendGrid\'s reasons', async () => {
  outcome = Object.assign(new Error('Forbidden'), {
    code: 403,
    response: { body: { errors: [{ message: 'The from address does not match a verified Sender Identity.' }] } },
  });
  const res = await post(email);
  assert.equal(res.status, 500);
  assert.equal(res.body.success, false);
  assert.equal(res.body.sendgrid_status, 403);
  assert.deepEqual(res.body.details, ['The from address does not match a verified Sender Identity.']);
});

test('a network failure is a 500 that says what went wrong', async () => {
  outcome = Object.assign(new Error('getaddrinfo ENOTFOUND api.sendgrid.com'), { code: 'ENOTFOUND' });
  const res = await post(email);
  assert.equal(res.status, 500);
  assert.equal(res.body.sendgrid_status, null);
  assert.deepEqual(res.body.details, ['getaddrinfo ENOTFOUND api.sendgrid.com']);
});

test('bodies over 1 MB get a 413', async () => {
  const res = await post({ ...email, text: 'x'.repeat(1_100_000) });
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
});

test('unknown routes get a JSON 404', async () => {
  const res = await fetch(`${base}/api/nothing-here`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Not found.' });
});
