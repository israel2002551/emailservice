// Starts the BUYSELL email service: reads settings from the environment (or from
// .env when run locally), sets up SendGrid and listens on PORT, which Render provides.
import 'dotenv/config';
import sgMail from '@sendgrid/mail';
import { createApp } from './app.js';

const env = (name) => (process.env[name] ?? '').trim();

const missing = ['SENDGRID_API_KEY', 'EMAIL_FROM', 'EMAIL_SERVICE_SECRET'].filter((name) => !env(name));
if (missing.length) {
  console.error(
    `Missing environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
      'Locally, copy .env.example to .env and fill it in; on Render, add them under Environment.',
  );
  process.exit(1);
}
if (env('EMAIL_SERVICE_SECRET').length < 32) {
  console.error('EMAIL_SERVICE_SECRET must be at least 32 characters long.');
  process.exit(1);
}

sgMail.setApiKey(env('SENDGRID_API_KEY'));
sgMail.setTimeout(30_000);

const app = createApp({
  from: env('EMAIL_FROM'),
  secret: env('EMAIL_SERVICE_SECRET'),
  sendMail: (mail, isMultiple) => sgMail.send(mail, isMultiple),
});

const port = Number(env('PORT')) || 3000;
const server = app.listen(port, (error) => {
  if (error) {
    console.error(`Could not start on port ${port}: ${error.message}`);
    process.exit(1);
  }
  console.log(`BUYSELL email service listening on port ${port}.`);
});

// Render sends SIGTERM before it replaces an instance: finish open requests, then exit.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received; closing.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
