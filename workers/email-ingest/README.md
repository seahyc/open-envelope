# OpenEnvelope email ingest Worker

Cloudflare Email Worker that POSTs raw RFC822 to the app. One routing rule covers every member. Do not add per-member Cloudflare addresses.

## Env

| Name | Kind | Purpose |
| --- | --- | --- |
| `OPENENVELOPE_INGEST_URL` | `[vars]` in `wrangler.toml` | App origin, no trailing slash. Example: `https://app.example.com` |
| `EMAIL_INGEST_HMAC_SECRET` | secret | HMAC-SHA256 of the raw body. Must match the app's `EMAIL_INGEST_HMAC_SECRET`. |

Set the secret with:

```
npx wrangler secret put EMAIL_INGEST_HMAC_SECRET
```

## Deploy

From this directory, after setting the var and secret:

```
npx wrangler deploy
```

The Worker name is `openenvelope-email-ingest`.

## Single Cloudflare Email Routing rule

The apex zone (`example.com`) already has a catch-all and custom rules. Leave those untouched.

Cloudflare Email Routing matches custom addresses exactly. `oe+token@example.com` does **not** land on a custom address `oe@example.com`; it falls through to the apex catch-all. Plus-addressing on the apex therefore cannot reach this Worker unless you change that catch-all or add one custom address per member.

Use a dedicated Email Routing hostname instead:

1. Enable Email Routing on `ingest.example.com` (child zone / Email Routing domain). Do not edit the apex catch-all.
2. Add **one** rule: catch-all `*@ingest.example.com` → **Send to a Worker** → `openenvelope-email-ingest`.

New members mint `slug-<16 hex>@ingest.example.com` in Connections. No further Cloudflare edits.

App env for that setup:

```
EMAIL_INGEST_DOMAIN=ingest.example.com
EMAIL_INGEST_HMAC_SECRET=<same value as the Worker secret>
PUBLIC_ORIGIN=https://<app host>
```

## Request the Worker sends

`POST {OPENENVELOPE_INGEST_URL}/api/ingest/email`

- `Content-Type: message/rfc822`
- `X-OE-Signature: <hex HMAC-SHA256 of the raw body>`
- `X-OE-Recipient: <envelope RCPT TO>` — `message.to`, not `To` / `Delivered-To`. Gmail forwarding keeps the original `To` (the member's Gmail). The envelope recipient is the ingest mailbox.
