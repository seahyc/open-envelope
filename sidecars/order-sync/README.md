# order-sync sidecar

This sidecar keeps marketplace orders flowing into OpenEnvelope from the server, without a
laptop. It runs a headless Chromium with a persisted profile for each shop. When a purchase
happens it opens the shop's own order page and pushes the newest orders to the signed ingest.

```
bank alert email -> IMAP poller -> pipeline creates a pending charge "LAZADA SG -45.67"
  -> matcher finds no order -> OrderSyncTrigger (debounced per shop, fresh charges only)
  -> POST http://order-sync:8787/trigger {shop}            (HMAC, private Docker network)
  -> scheduler: wait 45-180 s, then one run (20 min minimum gap per shop, one browser at a time)
  -> browser opens the shop and reads the first page of orders (limit 10)
  -> POST /api/ingest/orders (signed) -> upsert -> matcher links the order to the charge
  -> POST /api/ingest/orders/sync-status {ok|reauth_needed|blocked|error} -> shown on Home
fallback sweep: every 8 h +/-25% jitter, staggered per shop, limit 30
```

## Behaviour

- **Quiet.** Each run makes one landing page load and one order-list read for one shop. The
  user agent is pinned to the browser that provided the seed. Headless Chromium otherwise sends
  "HeadlessChrome", and Shopee answers that with a traffic-verification page. The profile is
  persistent per shop, locale and timezone are set to Singapore, and `AutomationControlled` is
  disabled.
- **Hard stops.** A 429, a non-JSON 403, or a captcha/challenge page (`blocked`), or a login
  redirect or "not logged in" answer (`reauth_needed`), halts that shop. The sidecar makes no
  further requests to it until a new seed arrives. Three consecutive transient errors also
  halt the shop. Every halt is reported, so the Home screen says "re-auth needed" instead of
  the sync going quiet.
- **Session upkeep.** After every good run, the cookies the shop refreshed are written back to
  `state.json` (Playwright storageState, mode 0600). This also keeps session-only cookies that
  a Chromium profile drops on restart.
- **Secrets.** `ORDER_SYNC_DATA_DIR/<shop>/` is mode 0700 and holds the session. Cookie values
  are never logged. Cookies for other domains in a seed are dropped.

## Seeding or re-seeding a shop (once, then whenever Home says "re-auth needed")

1. Sign in to the shop in your normal browser on your home network.
2. Export that shop's cookies, plus your browser's user agent, as
   `{"userAgent": "...", "cookies": [Playwright cookie objects]}`.
3. Move the file straight to the server without passing it through chat, logs or the repo,
   for example `scp seed.json server:/path/to/order-sync-data/<shop>/seed.json` with a `0700`
   parent directory.
4. The next trigger or sweep imports the file, deletes it, and clears the halt.

## Targets

`targets/<name>.mjs` exports `createTarget(env)`, which returns
`{ shop, cookieAllowed(cookie), sync(page, { reason, limit }) }`.
`sync` returns `{ state, detail?, orders }`, where the orders follow the JSONL contract in
`scripts/import-orders.mjs`. Only `synthetic` ships for now. The Shopee, Lazada and Amazon
targets have to be checked against a live signed-in session before they are added.

## Tests

`node --test sidecars/order-sync/test/*.test.mjs` runs against a synthetic local shop and a mock ingest.
It covers seeding, seed deletion, the pinned user agent, session restore across restarts,
reauth and blocked halts with no retries, error halting, re-seed recovery, the scheduler
(delay, coalescing, per-shop gap, jittered sweeps), and signed triggers.
