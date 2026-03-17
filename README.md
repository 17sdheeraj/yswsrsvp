# YSWS-RSVP

This app helps Hackclub members sign in with HCA, check channel membership, join YSWS Slack channels, mark RSVP completion, and quickly copy profile details for RSVP forms.

## Project structure

- `backend/worker.js` - Worker API + OAuth + Slack membership/join/RSVP logic + admin APIs
- `backend/public/ysws.json` - YSWS list used by the Worker (`/ysws.json`)
- `frontend/index.html` - user dashboard UI
- `frontend/script.js` - user dashboard logic
- `frontend/styles.css` - shared styles
- `frontend/admin.html` - admin dashboard UI
- `frontend/admin.js` - admin dashboard logic
- `frontend/404.html` - 404 page

## What this app does

- Authenticates users with HCA OAuth
- Reads user profile + Slack ID from HCA
- Checks whether user is already in each YSWS Slack channel
- Users can copy username, Slack ID, and email from the dashboard for filling YSWS forms quickly
- Lets user join channels via bot
- Lets user mark/unmark RSVP done per YSWS (persisted in KV)
- Completion bar is based on **join + RSVP** together
- Includes admin dashboard for metrics, audit logs, and view-as-user testing

---

## Prerequisites

1. Cloudflare account
2. HC Auth app (client ID and secret) - auth.hackclub.com
3. Slack bot token with channel read/invite permissions
4. Static hosting for frontend (GitHub Pages, Cloudflare Pages, etc.)

---

## 1) HC Auth app setup

Create an app in HC Auth Developer Apps.

Use this redirect URI:

`https://<your-worker-subdomain>.workers.dev/auth/callback`

Scopes required by this project:

- `openid`
- `profile`
- `email`
- `name`
- `slack_id`
- `verification_status`

---

## 2) Backend setup (Cloudflare Worker)

From the `backend` folder, configure:

### Secrets

From HC Auth

- `HC_CLIENT_ID`
- `HC_CLIENT_SECRET`

From Slack API

- `SLACK_TOKEN`

### Vars

- `FRONTEND_ORIGIN` = exact frontend origin (for CORS + cookies)
  - example: `https://your-frontend-domain.com`

### KV Binding

- `YSWS` (required)

Used for:

- metrics persistence
- audit logs
- rate-limit state
- RSVP done state per user

### Required data file

`backend/worker.js` imports `./public/ysws.json`.

Make sure this file exists at `backend/public/ysws.json`.

Format:

```json
[
  {
    "name": "Example YSWS",
    "form": "https://forms.fillout.com/t/xxxx",
    "channel": "C0123456789",
    "description": "optional",
    "website": ""
  }
]
```

### Deploy

Deploy Worker from `backend` using your preferred Cloudflare deployment workflow.

---

## 3) Frontend setup

In `frontend/index.html`, set:

```js
const API_BASE = "https://<your-worker-subdomain>.workers.dev";
```

Deploy all files in `frontend/` to your static host (`index.html`, `script.js`, `styles.css`, `admin.html`, `admin.js`, `404.html`).

---

## Runtime endpoints

### Auth

- `GET /auth/start`
- `GET /auth/callback`
- `GET /auth/logout`

### App API

- `GET /ysws.json` - YSWS list
- `GET /api/user` - profile + membership map + RSVP done map
- `POST /api/join` - join a Slack channel
- `POST /api/rsvp` - mark/unmark RSVP done for a channel

### Admin API

- `GET /api/admin/access`
- `GET /api/admin/metrics`
- `GET /api/admin/audit?limit=...`
- `DELETE /api/admin/audit`
- `DELETE /api/admin/audit?id=<eventId>`
- `DELETE /api/admin/errors`
- `GET /api/admin/view-as?slackId=...`
- `GET /api/admin/lookup?slackId=...`
- `POST /api/admin/test-join`
- `POST /api/admin/test-rsvp`

### Misc

- `GET /health` - health check

---

## CORS and cookies

- Worker sends CORS headers only when request origin matches `FRONTEND_ORIGIN`
- Frontend requests use `credentials: include`
- Session cookies are `SameSite=None; Secure`

---

## Common issues

### `not_authenticated`

User session cookie is missing/expired. Re-login via `/auth/start`.

### `missing_slack_id`

HC auth token was granted without `slack_id` scope. Logout and login again.

### `auth_expired`

HC token expired or revoked. Logout and login again.

### Invite failures

Slack bot likely lacks permissions or is not present in target channel.

### `rate_limited`

Too many join/RSVP requests from one IP in a short window. Wait for the reset time and retry.

---

## Notes

- Some parts of this project are vibecoded. This does not mean I vibecoded the whole website 😭 I spent alot of time fixing and testing this project
- Thanks to [HCA docs](https://auth.hackclub.com/docs/welcome) and [slack docs](https://docs.slack.dev/)!
- Code indentation by [prettier](https://prettier.io/)
- Thanks to [Saurabh Tiwari](https://hackclub.enterprise.slack.com/team/U09B8FXUS78) for testing and providing feedback when I first made this project! :)
- Contributors: [@Samhithpola](https://github.com/SamhithPola2025)