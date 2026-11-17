# Gmail filter forwarding for bank alerts

Each signed-in member sets this up on **Connections** (`/settings/connections`). No admin and no Cloudflare edit per member.

Self-serve mailbox mint, regenerate/revoke, Gmail confirmation code, filter query, and first-email check live on that page. This file is the operator checklist for the one-time Cloudflare + app env.

## App env

| Name | Purpose |
| --- | --- |
| `EMAIL_INGEST_DOMAIN` | Dedicated ingest hostname, `ingest.example.com` |
| `EMAIL_INGEST_HMAC_SECRET` | Shared HMAC-SHA256 secret with the Worker |
| `PUBLIC_ORIGIN` | Public https origin for Connections copy rows |

Do not set `EMAIL_INGEST_DOMAIN` to the apex `example.com` while that zone's existing catch-all must stay untouched.

## One Cloudflare routing rule

Apex `example.com` catch-all and custom addresses stay as they are.

Cloudflare Email Routing does not fold plus-tags onto a base address. `oe+<token>@example.com` hits the apex catch-all, not a custom address `oe@example.com`. Plus-addressing on the apex would need either a catch-all change or a custom address per member.

Least-invasive option that still scales:

1. Enable Email Routing on **`ingest.example.com`** (child zone / Email Routing domain).
2. Add the single rule **catch-all `*@ingest.example.com` → Send to a Worker → `openenvelope-email-ingest`**.

Members then receive `alex-<16 hex>@ingest.example.com` (or Sam, or any future household member) with no further Cloudflare work.

## Worker deploy

From `workers/email-ingest`:

1. Set `[vars] OPENENVELOPE_INGEST_URL` in `wrangler.toml` to the app origin.
2. `npx wrangler secret put EMAIL_INGEST_HMAC_SECRET` (same value as the app).
3. `npx wrangler deploy`

Worker name: `openenvelope-email-ingest`. Details: `workers/email-ingest/README.md`.

## Member Gmail steps (also shown in-app)

1. Connections → create mailbox. Copy the private address.
2. Gmail → Settings → Forwarding and POP/IMAP → Add a forwarding address.
3. When Gmail sends the confirmation, the code and link appear only on that member's card. Paste the code in Gmail.
4. Create a filter. Paste the in-app query (OCBC including `noreply@notify.ocbc.com`, DBS/POSB, UOB, Citi, HSBC, Standard Chartered, Maybank, Trust, GXS). Tick only **Forward it to** the ingest address. Leave **Skip Inbox** and **Delete** unchecked so the original stays in the inbox.
5. Forward an old bank alert. Connections shows when the first email arrived and the last parse method/confidence.

## Parsing

Alerts are bank-agnostic: amount + currency, Singapore date/time, last-4, merchant, and direction. Sender domain is only a confidence hint. Adding a bank is a row in `src/server/config/bank-alert-hints.ts` if you want a boost; no adapter is required. Low-confidence extracts fall back to the app LLM (`extractAlertFields`). The LLM never writes balances. If both fail, the email goes to review with its text.

## Access bypass

Keep an Access Bypass on `api/ingest/email` (see `docs/ux/context-signals.md` §13.2). Unsigned mail must return an empty 401, not an Access login page.
