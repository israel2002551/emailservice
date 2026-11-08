# BUYSELL email service

A small Express app that sends BUYSELL emails through [SendGrid](https://sendgrid.com). It runs on Render. When an admin sends a broadcast, the `send-broadcast` Supabase Edge Function (in the main BUYSELL repo, under `supabase/functions/send-broadcast`) picks the recipients, builds the email and hands it to this service:

```
Admin panel → send-broadcast (Supabase) → POST /api/send-email (this service, Render) → SendGrid
```

Only trusted servers may call it. Every request must carry the shared secret as `Authorization: Bearer <EMAIL_SERVICE_SECRET>`. Never call the service from the browser or put the secret in site code: anyone holding it can send email as BUYSELL.

## API

### `POST /api/send-email`

Send it with `Authorization: Bearer <EMAIL_SERVICE_SECRET>` and `Content-Type: application/json` headers.

| Field | Required | Notes |
|---|---|---|
| `to` | yes | One address, or a list of up to 1,000. Each recipient gets their own copy and never sees the other addresses. |
| `subject` | yes | One line, up to 255 characters. |
| `text` | yes | The plain-text body. |
| `html` | no | The HTML body. Mail apps that can't show HTML use `text`. |

Emails always come from `EMAIL_FROM`; callers can't change the sender.

```bash
curl -X POST http://localhost:3000/api/send-email \
  -H "Authorization: Bearer $EMAIL_SERVICE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"to":"you@gmail.com","subject":"Test from BUYSELL","text":"Hello!","html":"<p>Hello!</p>"}'
```

Every response is JSON:

| Status | When | Example body |
|---|---|---|
| 200 | SendGrid accepted the email | `{"success":true,"message":"SendGrid accepted the email for 1 recipient.","recipients":1,"message_id":"..."}` |
| 400 | A field is missing or invalid, or the body isn't JSON | `{"success":false,"error":"Missing required fields: subject, text.","missing":["subject","text"]}` |
| 401 | The secret is missing or wrong | `{"success":false,"error":"Missing or wrong service token."}` |
| 413 | The body is over 1 MB | `{"success":false,"error":"The request body is larger than 1 MB."}` |
| 500 | SendGrid refused the email or couldn't be reached | `{"success":false,"error":"SendGrid could not send the email.","sendgrid_status":403,"details":["The from address does not match a verified Sender Identity..."]}` |

A 200 means SendGrid queued the email. Bounces and spam reports appear later in SendGrid's Activity Feed.

### `GET /health`

Returns `{"ok":true}`. Render uses it to check that the service is up.

## Run it locally

You need Node.js 22 or newer.

```bash
git clone https://github.com/israel2002551/emailservice.git
cd emailservice
npm install
cp .env.example .env   # then fill in the values
npm start              # or `npm run dev` to restart on file changes
npm test               # SendGrid is replaced by a stand-in; nothing is sent
```

The service refuses to start if `SENDGRID_API_KEY`, `EMAIL_FROM` or `EMAIL_SERVICE_SECRET` is missing, or if the secret is shorter than 32 characters.

## Set up SendGrid

1. **API key.** In SendGrid, go to Settings → API Keys → Create API Key. Choose Restricted Access and set only Mail Send to Full Access. Copy the key, which starts with `SG.`; SendGrid shows it only once.
2. **Sender.** SendGrid only sends from addresses it has verified. Until yours is verified, every send fails with 403 "The from address does not match a verified Sender Identity". Either:
   - authenticate the domain (best for reaching inboxes): Settings → Sender Authentication → Authenticate Your Domain, for `buysell-marketplace.com`. SendGrid lists CNAME records; add them where the domain's DNS is managed (in Vercel: Domains → buysell-marketplace.com → DNS Records), then click Verify in SendGrid; or
   - verify a single sender address (quickest): Settings → Sender Authentication → Verify a Single Sender.
3. **Unsubscribe link (recommended for broadcasts).** Settings → Tracking → Subscription Tracking adds an unsubscribe link to every email, and SendGrid stops mailing people who use it.

## Deploy on Render

Render installs the packages with `npm ci` and starts the service with `npm start`, which `package.json` defines:

```json
"scripts": {
  "start": "node server.js"
}
```

`npm ci` installs exactly what `package-lock.json` lists, so commit the lock file whenever packages change.

### Option A: the Render dashboard

1. New → Web Service, then connect the `israel2002551/emailservice` GitHub repo.
2. Fill in:
   - Root Directory: leave it empty, since the service is at the top of the repo
   - Language: Node
   - Build Command: `npm ci`
   - Start Command: `npm start`
   - Health Check Path (under Advanced): `/health`
3. Under Environment Variables, add these. Enter the values without quotes.

   | Key | Value |
   |---|---|
   | `SENDGRID_API_KEY` | the key from SendGrid |
   | `EMAIL_FROM` | a verified sender, such as `BUYSELL Nigeria <info@buysell-marketplace.com>` |
   | `EMAIL_SERVICE_SECRET` | a long random string; see below |
   | `NODE_VERSION` | `24.12.0` |

   Don't add `PORT`: Render sets it, and the service listens on it. To make a secret, run:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. Create the service. When the deploy finishes, `https://<your-service>.onrender.com/health` shows `{"ok":true}`.

### Option B: a Blueprint

New → Blueprint and pick the `emailservice` repo; Render reads `render.yaml` from the top of the repo. It asks for `SENDGRID_API_KEY` and `EMAIL_FROM`, and makes `EMAIL_SERVICE_SECRET` itself. Copy that value from the service's Environment page for the next step.

### The free plan

A free Render service sleeps after 15 minutes without requests, and the next request waits about a minute while it wakes up. `send-broadcast` waits up to 100 seconds, so broadcasts still go out, just slower. Free instance hours are also shared by every free service in your Render workspace. The Starter plan avoids both.

## Connect it to Supabase

`send-broadcast` reads two secrets. Set them in the Supabase dashboard (Edge Functions → Secrets) or with the CLI:

```bash
npx supabase secrets set --project-ref tqxljdkavljlythspeej \
  EMAIL_SERVICE_URL=https://<your-service>.onrender.com \
  EMAIL_SERVICE_SECRET=<the same secret as on Render>
```

Then, from the main BUYSELL repo, deploy the function and send a test broadcast from the admin panel:

```bash
npx supabase functions deploy send-broadcast --project-ref tqxljdkavljlythspeej --use-api
```

Broadcasts go out in batches of 500, and each broadcast reaches at most 500 people unless the request sets `max_recipients` (up to 2,000).

To change the secret later, update it on Render and in Supabase at the same time; until both match, sends fail with 401.
