# order-sync sidecar (spike)

Keeps marketplace orders flowing into OpenEnvelope from the server, without a laptop.
A headless Chromium with a persisted profile opens the shop's own site, calls the shop's
order-list API from inside the page (same origin, so the session cookies ride along),
and pushes the orders to the signed ingest:

- `POST /api/ingest/orders` with `X-OE-Signature` (hex HMAC-SHA256 of the raw body, keyed by
  `EMAIL_INGEST_HMAC_SECRET`), body `{"orders": [...]}` in the JSONL contract of
  `scripts/import-orders.mjs`. Upserts by (shop, order_id) and re-runs charge matching.
- `POST /api/ingest/orders/sync-status` `{"shop", "state": "ok|reauth_needed|blocked|error", "detail"}`
  after every pass, so an expired session or a challenge page shows up on the home screen
  as "re-auth needed" instead of the sync silently stopping.

## Status

Only a synthetic target ships. `node --test sidecars/order-sync/test/` runs the sidecar
against a local fake shop and a mock ingest receiver and covers: no session -> `reauth_needed`;
one-time cookie jar seeding (the jar file is deleted after import, cookie values are never
logged, cookies for other domains are dropped); the session persisting in the profile for
later runs; a challenge page -> `blocked`.

Real shop targets are intentionally not included until they can be exercised against a live
session. Each one is a small object (see `syntheticTarget` in `sync.mjs`): landing URL,
login-URL detector, in-page fetch, and a `classify` that maps the response to the contract.

## Seeding a session (once per shop, and again whenever the app shows "re-auth needed")

1. Sign in to the shop in a normal desktop browser.
2. Export only that shop's cookies as a Playwright cookie JSON array.
3. Copy the file straight to the server (for example `scp` into a `0700` directory), never via
   chat, logs or the repo, then point `ORDER_SYNC_COOKIE_JAR` at it. The sidecar imports and
   deletes it on the next run; the profile directory then holds the session and must be
   treated as a secret (`0700`, excluded from backups that leave the host).

Session cookies without an expiry do not survive a profile restart in Chromium; seed cookies
that carry an expiry.

## Running (planned)

A small container from the official Playwright image (multi-arch, includes arm64) with
`playwright-core`, a volume for the profile, and the ingest secret from the same env file,
run every few hours with jitter. Keep the rate low: one order-list call per shop per run.
