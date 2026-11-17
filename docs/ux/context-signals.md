# Context signals

Triangulate a card charge with *where you were*, *what was on the calendar*, and *what was in the order email* — without sending raw coordinates, full calendars, or mailbox contents to the categoriser.

This slice is **off by default**. Data lives only in the app SQLite on the server, scoped per household member. Synthetic fixtures only in tests and `/api/dev/seed-ui`. No real Timeline, Gmail OAuth, or live personal data.

Self-serve **Connections** (Settings → Connections) is in this build: per-member mailboxes, calendar paste, OwnTracks device secrets, an unpacked Chrome extension, and **webhooks** (§18). Every Connections row is scoped by `household_id` (`docs/ux/onboarding-general.md`). This slice also lands the mailbox-audit parser order and the Review **payee notes** workflow. **Wallet-export plan** (§16) and **extension network-observe** (§17) stay **queued after** onboarding/tenancy + this parser/payee slice. Alipay / WeChat Pay statement import is the primary path for Taobao / Pinduoduo. Webhook ingest shares the same internal event pipeline as email, the extension, OwnTracks, and (queued) wallet import. Merge order stays onboarding/tenancy first.

## 1. Why

Opaque FAST/PayNow lines and marketplace descriptors (`SHOPEE *SG`, `ALIPAY*TAOBAO`, `JEWEL CHANGI`) do not name the real payee. Merchant memory and ACRA help. Three extra signals close more of the queue:

| Signal | Question it answers | What we keep |
| --- | --- | --- |
| Location | Were you physically at a place when the charge hit? | Place visits (cluster + name), not a forever GPS log |
| Calendar | Did a titled event overlap the charge? | Title, start/end, location string |
| Orders | Which receipt matches this charge, and who bought it? | Order + line items + buyer member |

Links are **evidence**, never automatic ledger writes. Splitting a charge into order items waits for a confirm tap. Budget maths, Ready to Assign, and envelope structure do not change.

## 2. Flags (all default off)

| Env | Default | On when |
| --- | --- | --- |
| `CONTEXT_LOCATION` | off | OwnTracks ingest + visit derivation + Nominatim |
| `CONTEXT_CALENDAR` | off | iCal poll (15 min) |
| `CONTEXT_ORDERS` | off | Receipt parsers on inbound mail |
| `CONTEXT_TRIANGULATE` | off | Matching step + Review/ledger snippets |
| `CONTEXT_WEBHOOK` | off | `POST /api/hooks/:hookId` (auth still runs when off) |

Accepted truthy tokens: `1`, `true`, `on`, `yes` (case-insensitive). Anything else, including unset, is off.

Triangulate may run when at least one source flag is on **and** `CONTEXT_TRIANGULATE` is on. Sources without their flag do not ingest. Pipeline nodes still appear in `/pipeline` with `enabled: false` when off.

## 3. Pipeline

Document import stays linear. Context sources are **sibling ingest sources**, not bank adapters.

```
                    ┌ location (OwnTracks HTTP)
ingest → … → categorize → triangulate → flag-rules → review-queue
                    ├ calendar (iCal poll)
                    ├ orders (receipt email / wallet export / later extension)
                    └ webhook (typed events / mapped JSON)
```

- `triangulate` sits **after** `categorize`. It proposes `context_links` for the document’s matched transactions (and can be invoked from ingest/poll for signals that arrived first).
- Categoriser prompt, if links already exist from an earlier signal, receives **only** a one-line snippet: place name, event title, item names. Never lat/lng, never the iCal URL, never the raw MIME.
- `/pipeline` shows `source:location`, `source:calendar`, `source:orders`, `source:webhook` as `signal-source` nodes fanning into `triangulate`.
- Email, extension, OwnTracks, webhooks, and queued wallet import all dispatch through one internal event pipeline (`IngestEventPipeline`). Webhooks never set balances or create transactions.

## 4. Location (OwnTracks)

Google has no supported API for live location or Timeline. We accept **OwnTracks-compatible HTTP JSON**.

### 4.1 Cloudflare Access (you apply this)

`POST /api/ingest/location` must sit on an **Access BYPASS** path. The OwnTracks app in HTTP mode cannot send Cloudflare Access service-token headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`): Android has no extra-header field, and iOS `httpHeaders` is stripped or dropped across Access redirects. Do **not** put a service-token requirement on this path. Auth is in-app HTTP Basic (§4.2). The app JWT middleware already skips this path (same as `/api/ingest/email`); Access still has to let the request through.

Keep the existing origin-wide self-hosted Access application (Allow + email allowlist / JWT) unchanged. Add a **second**, more-specific self-hosted application for this path only. Cloudflare [application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) give the more specific destination precedence, so `https://<host>/api/ingest/location` hits Bypass and every other path stays on the existing Allow app. Do **not** add a Bypass policy to the origin-wide app — that would open the whole site.

Apply this in the Cloudflare dashboard (not encoded as a live change in this repo):

1. Zero Trust → **Access controls** → **Applications** → **Create new application**.
2. Type: **Self-hosted and private**.
3. **Add public hostname**. Same subdomain + domain as the existing OpenEnvelope Access app (leave subdomain empty if the origin is the zone apex).
4. **Path**: `api/ingest/location`  
   Exact path, no trailing slash, no `*`. OwnTracks POSTs this URL and nothing under it.
5. Application name: `OpenEnvelope OwnTracks ingest`.
6. Identity providers / instant auth / Cloudflare One Client: leave off. Session duration is unused under Bypass.
7. **Access policies** → create a **new** policy (do not reuse the origin Allow policy):

| Field | Value |
| --- | --- |
| Policy name | `Bypass OwnTracks` |
| Action | **Bypass** |
| Rule type | Include |
| Selector | **Everyone** |
| Value | Everyone |

8. Do **not** add Require or Exclude rules. Do **not** add Service Auth. Do **not** add a service token. Do **not** add email, IdP, country, or IP selectors.
9. Save. Confirm Applications lists both:
   - existing OpenEnvelope app → destination `<host>` (or `<host>/*`) → Allow
   - `OpenEnvelope OwnTracks ingest` → destination `<host>/api/ingest/location` → Bypass

Equivalent Access policy JSON if you prefer the API (`POST /accounts/$ACCOUNT_ID/access/policies`) instead of the dashboard:

```json
{
  "name": "Bypass OwnTracks",
  "decision": "bypass",
  "include": [{ "everyone": {} }]
}
```

Attach that policy only to a self-hosted application whose destination is `<host>/api/ingest/location`.

Smoke check after you apply it: `curl -i -u 'wrong:wrong' -H 'Content-Type: application/json' -d '{"_type":"location","lat":0,"lon":0,"tst":0}' https://<host>/api/ingest/location` must reach the origin (not an Access login HTML page) and return **401 with an empty body**.

### 4.2 In-app auth

- HTTP Basic.
- Username = device id (`{memberSlug}-{device}`, e.g. `alex-iphone`).
- Password = random per-device secret, stored **hashed** (scrypt + salt) in `location_devices`.
- Optional OwnTracks payload encryption: `_type: encrypted` + `data` (libsodium secretbox / XSalsa20-Poly1305). The server decrypts with a per-device key from `LOCATION_ENCRYPT_KEYS`. Paste the **same** string the app uses as Encryption Key: a passphrase of at most 32 UTF-8 bytes (NUL-padded to 32, as OwnTracks iOS/Android do), or 64-char hex / standard base64 of a 32-byte key. Keys never go in the repo or in SQLite plaintext. No comma in the passphrase (env list separator).
- Accept `_type: location` objects, or a JSON **array** (offline queue, including encrypted items in the array). Ignore every other `_type` (cmd, lwt, beacon, …) with `202` and no body of interest.
- Rate-limit per device (60 posts / minute). Excess → `429`.
- Anything else (missing/wrong Basic, unknown device, decrypt fail) → **`401` with empty body**. No hint.

When `CONTEXT_LOCATION` is off → `404`.

### 4.3 OwnTracks app setup (iOS / Android)

Use the stock OwnTracks app in **HTTP** mode. Do not use MQTT. Do not put Cloudflare Access service-token headers anywhere. Credentials go in Identification, not in the URL (`https://user:pass@host/…` is mangled on some Android stacks).

Provision the device first on the server (`LOCATION_DEVICES=alex-iphone:Alex:<random-secret>` and, if encrypting, `LOCATION_ENCRYPT_KEYS=alex-iphone=<same-passphrase>`), then enter those values in the app.

**iOS**

1. OwnTracks → settings (gear / **i**) → **Mode**: **HTTP** (not MQTT).
2. **URL**: `https://<host>/api/ingest/location` (https only).
3. **Authentication**: on.
4. **UserID** (username): the device id, e.g. `alex-iphone`. This is the HTTP Basic username and must match `location_devices.id`.
5. **Password**: the per-device secret (HTTP Basic password). Not the encryption key.
6. Encryption (optional): **Secret encryption key** / `encryptionKey` = the same ≤32-character passphrase as `LOCATION_ENCRYPT_KEYS` for that device. Leave empty if the env key is unset.
7. Extra HTTP headers (`httpHeaders`): leave empty.
8. **Monitoring**: **Significant** (`monitoring = 1`). Not Move (GPS drain), not Manual, not Quiet.
9. Allow Always location permission when iOS asks.

**Android**

1. OwnTracks → **Preferences** → **Connection** → **Mode**: **HTTP** (not MQTT).
2. **Host** / URL: `https://<host>/api/ingest/location` (https only).
3. **Authentication**: on.
4. **Username**: the device id, e.g. `alex-iphone` (HTTP Basic username).
5. **Password**: the per-device secret (HTTP Basic password).
6. **Encryption Key** / `encryptionKey` (optional): the same ≤32-character passphrase as `LOCATION_ENCRYPT_KEYS`. Leave empty if unset.
7. **Monitoring**: **Significant** / **Significant changes** (`monitoring = 1`). Not Move.
8. Optional: **Autostart on boot** on.

A successful publish is any HTTP **2xx**. This endpoint returns `202` with `{ "accepted": N }` for location points, `202` with `{ "accepted": 0 }` for ignored `_type`s, and empty-body `401` / `404` / `429` otherwise. Offline OwnTracks queues replay as a JSON array of `_type: location` (or encrypted wrappers); the endpoint accepts that batch.

Home Assistant’s OwnTracks integration can POST the same JSON with the same Basic credentials.

Config-file equivalents (`*.otrc`): `mode: 3` (HTTP), `url`, `auth: true`, `username`, `password`, optional `encryptionKey`, `monitoring: 1`.

### 4.4 Retention

- Store raw points (`location_points`) for **max 90 days**.
- Derive **place visits**: lat/lng cluster (consecutive points within ~120 m, dwell ≥ 8 min), arrive/leave, reverse-geocoded name.
- Reverse geocode via **OSM Nominatim** only (`https://nominatim.openstreetmap.org/reverse`), `User-Agent: OpenEnvelope/0.1`, **1 request/second**, cache by ~100 m geohash in `geocode_cache`. Never hit Nominatim in `VITEST`.
- After 90 days, delete the raw points. Keep `place_visits`.

## 5. Calendar

- Each member may have one Google Calendar **secret address in iCal format** (Settings → Integrate calendar → Secret address in iCal format).
- URL is a **secret**. Not in git. Stored encrypted at rest (`AES-256-GCM` with `CONTEXT_SECRET_KEY`) in `member_calendar_feeds`.
- Poll every **15 minutes** when `CONTEXT_CALENDAR` is on (timer skipped under `VITEST`; tests call `poll()` with a mock fetch).
- Keep: event `UID`, title (`SUMMARY`), start, end, location string. Drop description, attendees, conference URLs.
- Env bootstrap (optional): `CALENDAR_ICAL_URLS=alex=https://calendar.google.com/calendar/ical/…/basic.ics` keyed by member slug. Loaded at boot into the encrypted table; never logged in full.

## 6. Orders (receipt email)

No Gmail OAuth. Each member forwards filtered mail to a per-member ingest address. A Cloudflare Email Worker (`workers/email-ingest`) receives it, HMAC-signs the raw MIME, and POSTs to `POST /api/ingest/email` (Access Bypass). The app attributes the mail to that member, then:

1. Gmail forwarding-confirmation → store code/link on the Connections card (do not parse as an order).
2. Receipt parsers (below) → `orders` + `order_items` with `member_id`, **no** bank observation.
3. Bank-alert adapters (OCBC card / PayNow / NETS first; DBS PayLah second) → existing alert pipeline.

Exact Gmail filter query to paste (audit order — shops that actually arrive, plus OCBC alerts; DBS PayLah is second):

```
from:(order@lazada.sg OR receipts@grab.com OR no-reply@grab.com OR no-reply@gojek.com OR receipts@ryde.sg OR t.shopifyemail.com OR googleplay-noreply@google.com OR alerts@ocbc.com.sg) OR from:(alerts@dbs.com.sg OR noreply@dbs.com.sg)
```

Amazon SG, FairPrice, and Shopee stay parsed if a file shows up, but they are **not** in the paste-this filter: those emails are not arriving in practice.

Raw MIME is kept **30 days** (`inbound_mail` + object store), then deleted.

This build’s parsers (synthetic fixtures modelled on public formats, not live mail):

| Priority | Merchant | Fixture id |
| --- | --- | --- |
| 1 | Lazada “Receipt for order” (HTML + PDF attachment line items) | `fixtures/context/lazada-receipt.eml` + generated PDF in tests |
| 2 | Grab e-receipts (rides + GrabFood; booking ID; fare breakdown) | `fixtures/context/grab-ride-receipt.eml`, `fixtures/context/grab-food-receipt.eml` |
| 3 | Gojek invoices | `fixtures/context/gojek-invoice.eml` |
| 4 | Ryde trip receipts | `fixtures/context/ryde-receipt.eml` |
| 5 | Shopify store receipts (`t.shopifyemail.com`) | `fixtures/context/shopify-receipt.eml` |
| 6 | Google Play receipts | `fixtures/context/google-play-receipt.eml` |
| later | Shopee / Amazon SG / FairPrice | existing fixtures; not in the Gmail filter |

Bank alerts (statement is still source of truth; alerts are provisional):

| Priority | Adapter | Fixture id |
| --- | --- | --- |
| 1 | OCBC card + PayNow + NETS | `fixtures/singapore/ocbc-card-alert.eml`, `fixtures/context/ocbc-paynow-alert.eml`, `fixtures/context/ocbc-nets-alert.eml` |
| 2 | DBS PayLah (then other DBS alerts) | `fixtures/singapore/paylah-alert.eml`, `dbs-alert.eml` |

When `CONTEXT_ORDERS` is on, inbound mail that matches a parser writes `orders` + `order_items` (merchant, order id, items, qty, unit/line cents, total, date, buyer `member_id`) and does **not** create a bank observation. Bank-alert mail still follows the alert adapters. Lazada PDF attachments are decoded, text-extracted, and merged with the HTML body before parse.

Buyer member is the household member who owns the ingest mailbox (or the extension token). Seed still attributes demo orders to **Alex**.

## 7. Matching (`triangulate`)

All matches are proposed links (`context_links.status = proposed`). User confirm flips to `confirmed`. Reject drops the link. No amount, balance, or envelope write on propose.

### 7.1 Order ↔ card charge

- Date window: order date ± 2 days vs transaction timestamp.
- Amount: exact cents, **or** within 2 % (FX), **or** sum of several same-merchant orders in the window (multi-order checkout).
- Merchant: normalised token overlap (`LAZADA`, `GRAB`, `GOJEK`, `RYDE`, `SHOPIFY`, `GOOGLE`/`PLAY`, `ALIPAY`/`TAOBAO`/`PINDUODUO`/`PDD`, and later `SHOPEE` / `AMAZON` / `FAIRPRICE`).
- Snippet: `Shopee order #220101: 2 items`.
- **Who spent**: `spent_attributions.member_id` from the order’s buyer, independent of which card paid. Shown on Review as `Alex spent` — not a budget owner change.
- **Split (pending confirm)**: if one charge matches one order with 2+ items, store `proposed_split` JSON. Confirm copies item names into `transactions.notes` and marks the link confirmed. It does **not** explode the ledger row into child amounts (budget maths stay untouched).
- **Wallet CNY ↔ SGD card** (queued, §16): same ±2 day window. Amount is CNY line/order total vs card SGD cents within the existing 2 % FX slack (and the reverse: several wallet rows may sum to one `ALIPAY*TAOBAO` / Pinduoduo card charge). Closed / refunded wallet rows do not match. Snippet: `Taobao 不锈钢保温杯, 杯刷替换头` (item names only).

### 7.2 Place visit ↔ charge

- Time: transaction timestamp inside `[arrived_at − 30 min, left_at + 30 min]`.
- Place: merchant text / L2 category tokens overlap the Nominatim name (or a seeded display name).
- Snippet: `at Jewel Changi 2:10–2:40pm` (display times in `en-SG`, no coordinates).

### 7.3 Calendar ↔ charge

- Time: timestamp inside `[start − 30 min, end + 30 min]`.
- Text: event title or location overlaps merchant tokens.
- Snippet: `calendar: Dinner`.

## 8. Surfaces

- **Review card** — evidence lines under the meta row (`data-testid="review-context"`). Optional chip `split into N items` when `proposed_split` is present. Opaque PayNow/FAST/ATM lines show **payee notes** (`data-testid="review-payee"`): tag the payee once (e.g. Renovation contractor / Allowance to partner / Cash) with an optional project label (e.g. Home renovation). Save writes a `payee_notes` memory rule for that `merchant_key` (and UEN when ACRA parsed one). ACRA/UEN enrichment stays on the same card. One-off large items can be marked `xfer.capital` (non-budget capital transfer) without teaching memory.
- **Ledger** — expanding a row shows the same snippets (`data-testid="ledger-context"`).
- **Categoriser** — `Context: at Jewel Changi; Dinner; AirPods, cable` (names only).
- **Settings → Connections** — `/settings/connections`, also in Accounts → More. Per signed-in member in **this household** (`household_id` + member). Desktop column 1040px; mobile 375.

Empty: no extra UI. Loading/error: existing Review/ledger patterns. Failures in Nominatim, iCal fetch, or decrypt are non-fatal and never leak URLs or keys in logs.

## 9. Schema (migrations v10 + v12 + v16)

See `src/server/db/migrations.ts` version 10, name `context_signals`, and version 12, name `context_connections`:

- `location_devices` — device id, member_id, scrypt salt/hash
- `location_points` — raw points + `recorded_at` (90-day job)
- `place_visits` — cluster + geocoded name
- `geocode_cache` — Nominatim cache
- `member_calendar_feeds` — encrypted iCal URL
- `calendar_events` — title/start/end/location
- `orders` / `order_items`
- `context_links` — kind `order|place|calendar`, snippet, proposed_split, status
- `spent_attributions` — transaction_id → member_id
- `ingest_mailboxes` — per-member `local_part` + Gmail verify code/link
- `inbound_mail` — 30-day raw mail index (`document_hash`, kind, `received_at`)
- `extension_tokens` — hashed per-member extension bearer tokens
- `member_calendar_feeds.last_error` / `last_fetched_at`
- `orders.source` — `email` | `extension` | `webhook` | (queued) `wallet`
- `ingest_hooks` / `ingest_hook_events` — per-member webhook endpoints, sealed secrets, mapping templates, 30-day raw payloads (v16)

## 10. Secrets / env (not in repo)

| Name | Purpose |
| --- | --- |
| `CONTEXT_LOCATION` / `CONTEXT_CALENDAR` / `CONTEXT_ORDERS` / `CONTEXT_TRIANGULATE` / `CONTEXT_WEBHOOK` | Feature flags (default off) |
| `LOCATION_DEVICES` | `deviceId:memberSlug:secret` comma-separated; hashed at boot |
| `LOCATION_ENCRYPT_KEYS` | `deviceId=<passphrase>` (≤32 chars, NUL-padded) or `deviceId=<64-hex>` or `deviceId=<base64-32>` for OwnTracks secretbox |
| `CALENDAR_ICAL_URLS` | `memberSlug=https://calendar.google.com/calendar/ical/…/basic.ics` |
| `CONTEXT_SECRET_KEY` | 32-byte hex/base64; AES-GCM for iCal URLs at rest |
| `NOMINATIM_URL` | override (tests inject a mock; default OSM) |
| `NOMINATIM_USER_AGENT` | default `OpenEnvelope/0.1` |
| `EMAIL_INGEST_DOMAIN` | dedicated ingest hostname, e.g. `ingest.example.com` (mailbox `alex-<16 hex>@…`). Do not reuse an apex catch-all you must keep. |
| `EMAIL_INGEST_HMAC_SECRET` | shared HMAC-SHA256 secret; Worker header `X-OE-Signature` |
| `PUBLIC_ORIGIN` | public https origin used on Connections copy rows |

Plus existing Access JWT env for the rest of `/api/*`. Location, email, orders, and webhook ingest stay off the JWT path.

## 11. Privacy rules

- Server-side only. No browser geolocation. No calendar OAuth token.
- Categoriser / Codex / web search never see coordinates, iCal URLs, device ids, or raw email.
- 401 on location ingest has **no** body.
- 401 on email ingest (bad HMAC / unknown mailbox), orders ingest (bad token), and webhook ingest (bad HMAC / bearer / unknown hook / replay) has **no** body.
- Retention job deletes `location_points` older than 90 days and `inbound_mail` / `ingest_hook_events` (+ blobs) older than 30 days; does not delete visits or confirmed links.
- Wallet zip passwords are typed in the browser and never stored (queued §16).

## 12. Connections (this build)

**Route:** `/settings/connections` (`data-testid="connections-shell"`). Identity is the session (or Access JWT) mapped to `household_members` **in the current household**. Tenant `#1` self-host allowlist still maps first `ALLOWED_EMAILS` → Alex, second → Sam. `AUTH_MODE=none` uses the first member of `hh-1`. Members only see and can delete **their** sources. Partner feeds never appear on this page.

Cards (`data-testid="conn-email|calendar|location|extension|webhook"`, `data-status=`):

| Status | Meaning |
| --- | --- |
| `unset` | not set up |
| `waiting` | configured, no data yet (incl. Gmail verify pending) |
| `healthy` | last data within 7 days |
| `stale` | last data older than 7 days |
| `error` | last ingest/fetch failed (no secret in the message) |

Each card: last received, counts, step-by-step setup, **copy** buttons, disconnect & delete my data.

- **Alerts & receipts** — each member mints `{slug}-{16 hex}@EMAIL_INGEST_DOMAIN`, can regenerate or revoke. Copy address + Gmail filter (OCBC, DBS/POSB, UOB, Citi, HSBC, SC, Maybank, Trust, GXS). Show Gmail confirmation code/link only to them. Filter forwards and keeps the original in the inbox. First-email / last parse method and confidence on the card.
- **Calendar** — paste secret iCal HTTPS URL (`calendar.google.com` only). Fetch once; store AES-GCM encrypted.
- **Location** — mint device id `{slug}-phone` + random secret (shown once). OwnTracks HTTP as §4.3.
- **Browser extension** — mint `ext.{id}.{secret}` (shown once). Load `extension/` unpacked. Toolbar click only. This build: Shopee / Lazada HTML extract (`extension/extract.js`). Queued (§17): **replace DOM scrape** with page-context network observe on Taobao **已买到的宝贝** plus Lazada / Shopee order pages. **Pinduoduo is not covered** (mobile-only) — Alipay / WeChat Pay import (§16) is the PDD path and remains primary for Taobao too.
- **Webhooks** — one or more hooks per member. Mint URL + secret (shown once). Mapping textarea with live preview of the last sample. Send-test console with curl and iOS Shortcuts examples. Last received, counts, errors. See §18.

## 13. Cloudflare you apply (Email Routing + Access)

### 13.1 Email Routing + Worker (free tier)

1. Enable **Email Routing** on a dedicated hostname (`ingest.example.com` as a child zone / Email Routing domain). Leave the apex `example.com` catch-all and custom rules untouched. Plus-addressing on the apex (`oe+token@example.com`) falls through to that catch-all — Cloudflare does not fold `+tags` onto a base custom address.
2. From repo `workers/email-ingest`: set `OPENENVELOPE_INGEST_URL` to the app origin, `npx wrangler secret put EMAIL_INGEST_HMAC_SECRET` (same value as the app), deploy with `npx wrangler deploy`.
3. **One** routing rule: **Catch-all** `*@ingest.example.com` → **Send to a Worker** → `openenvelope-email-ingest`. New members never need another Cloudflare address.
4. App env: `EMAIL_INGEST_DOMAIN=ingest.example.com`, `EMAIL_INGEST_HMAC_SECRET=…`, `PUBLIC_ORIGIN=https://<app host>`.

Worker POSTs `Content-Type: message/rfc822`, `X-OE-Signature: <hmac-sha256 hex of raw body>`, `X-OE-Recipient: <envelope RCPT TO, not Gmail To>`. See `docs/GMAIL_SETUP.md` and `workers/email-ingest/README.md`.

### 13.2 Access Bypass for email, orders, and webhook ingest

Same recipe as §4.1 (second self-hosted app, more specific path, Bypass + Include Everyone, no service token). Add apps (or destinations) in addition to OwnTracks:

| Application name | Path | Policy |
| --- | --- | --- |
| `OpenEnvelope email ingest` | `api/ingest/email` | `Bypass Email ingest` — Action **Bypass**, Include **Everyone** |
| `OpenEnvelope orders ingest` | `api/ingest/orders` | `Bypass orders ingest` — Action **Bypass**, Include **Everyone** |
| `OpenEnvelope webhook ingest` | `api/hooks/*` | `Bypass webhook ingest` — Action **Bypass**, Include **Everyone** |

Do not Bypass the origin-wide app. Smoke: unsigned `curl` to email, orders, or a hook URL must hit origin and return **401 empty body**, not an Access login page.

## 14. Follow-ons (queued)

Tenancy + general onboarding is on `docs/ux/onboarding-general.md` (this Connections slice is already household-scoped). Parser audit + payee notes are **this** slice.

**Next after this slice:** wallet statements **§16** (primary for Taobao / Pinduoduo) then extension network-observe **§17** (secondary; not Pinduoduo). Both specified, not built. Webhook ingest **§18** is specified and wired in this follow-on; still merge **after** onboarding/tenancy.

Every new table in those follow-ons is born with `household_id`. Do not add implicit household #1.

## 15. Payee notes (opaque FAST / PayNow / ATM)

Largest unexplained Review bucket: contractors, people, tax, cash — rails that name a truncated payee or none.

- **Sees:** merchant line, ACRA/UEN line when we have one, then `Tag this payee` + optional `Project`.
- **Saves:** `payee_notes(household_id, merchant_key, payee_label, project, category_id)`. Also a merchant-memory hit so the next identical PayNow line auto-suggests. Combined with ACRA: the enrichment line stays; the user’s label is the household name for that key.
- **Capital transfer:** `[ mark as capital transfer ]` sets category `xfer.capital` (kind `transfer`, excluded from envelopes / Ready to Assign like other `xfer.*`). One-off — does **not** write memory (a home-purchase cashier’s order should not categorise the next PayNow).
- Empty: not shown on named shops. Error: `✕` nothing saved. Re-entry: saved label pre-fills.

## 16. Wallet statements (Taobao / Pinduoduo) — queued

Taobao and Pinduoduo **do not** send itemised order emails. Cover them with payment-wallet **statement exports**, treated as order-level evidence (same `orders` + `order_items` + triangulate path as receipt mail). They never create bank observations, never set balances, and never change envelope / RTA maths. Implementation stays **after** onboarding/tenancy and the parser/payee slice. Synthetic fixtures only — no live Alipay/WeChat mail, no real nicknames.

### 16.1 Why wallet export

| Shop | Itemised order email? | Path |
| --- | --- | --- |
| Taobao | No | Alipay transaction statement (primary). Optional Chrome extension on the user’s own web **已买到的宝贝** page. |
| Pinduoduo | No | Alipay and/or WeChat Pay bill (primary). **Not** the extension — PDD is mobile-only. |

SGD card descriptors to match: `ALIPAY*TAOBAO`, `ALIPAY*PINDUODUO`, `PDD*`, `PINDUODUO`, and WeChat Pay / `WECHATPAY` / `TENPAY` variants. Match window: wallet timestamp ± 2 days vs card `timestamp`. Amount: CNY (fen) vs card SGD cents within the existing **2 %** FX slack, **or** several successful wallet rows of the same shop summing to one card charge. Closed / 交易关闭 / refunded rows are skipped.

When one card charge matches an order (or a set of wallet rows) with 2+ goods lines, store `proposed_split` the same way as Shopee/Lazada receipts. Confirm copies item names into `transactions.notes` and does **not** explode the ledger row.

### 16.2 Alipay transaction statement

Alipay emails a **password-protected zip** whose CSV may be **GBK or UTF-8**. Columns we keep (public export layout):

| Column | Use |
| --- | --- |
| 交易创建时间 / 付款时间 | `ordered_at` |
| 交易对方 | counterparty (淘宝 / 拼多多 / shop name) |
| 商品说明 | item name |
| 金额（元） | CNY → `line_cents` / `total_cents` (fen) |
| 收/支 | skip 收入 |
| 交易状态 | keep 交易成功 only |
| 商家订单号 / 交易号 | `order_ref` (prefer 商家订单号; fall back to 交易号) |

Several 商品说明 rows that share a 商家订单号 become **one** order with multiple `order_items` (`merchant` `taobao` or `pinduoduo` from 交易对方 / 交易来源地). Fixture: `fixtures/context/alipay-taobao.csv` (UTF-8 model of the public layout). Tests later generate a GBK copy inside an AES zip with password `synthetic` — the app **never** stores that password.

### 16.3 WeChat Pay bill

WeChat Pay export is CSV or XLSX (no zip, or a zip without a password). Columns we keep:

| Column | Use |
| --- | --- |
| 交易时间 | `ordered_at` |
| 交易对方 | counterparty |
| 商品 | item name |
| 金额(元) | CNY, strip `¥` |
| 收/支 | skip 收入 |
| 当前状态 | keep 支付成功 only |
| 商户单号 / 交易单号 | `order_ref` |

Fixture: `fixtures/context/wechat-pay-bill.csv`. XLSX is the same columns; parse in the follow-on with the existing sheet reader if present, otherwise convert in tests.

### 16.4 How they get in

**This follow-on (Import upload) — primary**

1. Settings → Import (existing `ImportView`). Accept `.zip`, `.csv`, `.xlsx`.
2. If the file is a passworded zip: show `data-testid="import-zip-password"` (type=password). Unzip **in the browser**; send only the inner CSV/XLSX bytes to `POST /api/import`. The password never goes on the wire, never hits SQLite, never appears in logs.
3. Empty: password field required when the zip is encrypted. Error: `✕` wrong password / unknown layout (GBK and UTF-8 both tried). Re-entry: user picks the file again; password is not remembered.
4. Detect Alipay vs WeChat from the preamble / headers (支付宝交易记录 / 微信支付账单). Write `orders.source = 'wallet'`, `currency = 'CNY'`, buyer = current member. Then `triangulate` against recent SGD card charges.

**Later (email ingest)**

Alipay’s zip-in-email can land on the member mailbox (do **not** add Alipay to the paste-this Gmail filter in the current build). Store the raw MIME 30 days. The next Import / Review prompt is “this zip needs a password”; they type it in the browser against the stored blob. Still never persist the password. WeChat bills that arrive as attachments follow the same path.

### 16.5 Chrome extension (secondary)

**Alipay / WeChat Pay statement import is the primary path.** The extension is optional extra evidence on **web** order lists. Spec: **§17**. **Pinduoduo is not covered by the extension** (mobile-only).

### 16.6 Synthetic match examples (not live data)

| Wallet evidence | Card merchant | CNY | Illustrative SGD |
| --- | --- | --- | --- |
| Alipay 商家订单号 `TB20261012001` — 不锈钢保温杯 + 杯刷替换头 | `ALIPAY*TAOBAO` | 101.50 | ~S$20.70 |
| Alipay 拼多多 抽纸 6包 `PDD20261013088` | `ALIPAY*PINDUODUO` | 29.90 | ~S$6.10 |
| WeChat Pay 拼多多 抽纸 6包 `PDD20261013111` | `ALIPAY*PINDUODUO` / WeChat Pay | 29.90 | ~S$6.10 |

`orders.merchant` values: `taobao`, `pinduoduo`. Token overlap on the card side: `ALIPAY`, `TAOBAO`, `PINDUODUO`, `PDD`. Budget maths unchanged.

## 17. Chrome extension network-observe — queued

Replace the current toolbar HTML extract (`extension/extract.js`, Shopee / Lazada only) with **observing JSON the page itself already fetched**. Implementation stays after onboarding/tenancy and the parser/payee slice. Synthetic fixtures only.

**Primary path for Taobao / Pinduoduo remains §16 wallet import.** Extension evidence is additive. **Pinduoduo is not covered** — there is no supported PDD web bought-items page; do not add PDD host permissions.

### 17.1 What the user does

1. On **their own** order-list page, click the toolbar button (no background polling, no idle scrape).
2. Allowed pages: Taobao **已买到的宝贝** (`buyertrade.taobao.com` / `*.taobao.com` trade itemlist), Lazada order history (`*.lazada.sg`), Shopee purchase list (`shopee.sg` / `*.shopee.sg`).
3. The extension POSTs normalised orders to `POST /api/ingest/orders` with the existing member bearer token (`ext.{id}.{secret}`).
4. Empty: not an allowed page → no request, options page if token missing. Error: ingest **401 empty body** (unchanged). Re-entry: click again after the page has loaded its list.

### 17.2 How capture works (page context only)

On toolbar click, inject a **page-context** script (not the isolated content-script world) that wraps `window.fetch` and `XMLHttpRequest.prototype` **on that tab, for that page load**, and reads response bodies the shop UI already requested.

- Capture JSON whose URL or body looks like an order list (bought-list / order/get / purchase list). Do not navigate. Do not click shop UI.
- If the list was fetched **before** the click, keep a short in-page buffer of recent order-list responses (same page lifetime only) so one click can reuse what the SPA already loaded. Buffer dies with the tab. Never persist it to `storage`.
- Normalise with `extension/observe-normalise.js`: `merchant`, `order_id`, `placed_at`, `currency`, `total_cents`, `items[{name, qty, unit_cents, line_cents}]`. Taobao amounts are **CNY** (fen). Lazada SG / Shopee SG stay SGD.
- Then POST `{ orders }` to OpenEnvelope only.

### 17.3 Hard rules

| Rule | Required behaviour |
| --- | --- |
| User-initiated only | Toolbar click. No `alarms`, no `webRequest` listener that fires in the background, no idle crawl. |
| Never call shop APIs | Do **not** `fetch` shop hosts from the extension. Do **not** replay, resign, or reissue the page’s requests. Observe responses only. |
| No cookies / credentials | Do not read `document.cookie`, `chrome.cookies`, Authorization headers, or localStorage shop tokens. Do not store them. |
| Minimal host permissions | Only the three shop order-list origins above, plus the user’s OpenEnvelope origin (already via `fetch` to configured origin). **No** `pinduoduo.com` / `yangkeduo.com`. |
| No background polling | Service worker handles the click, then goes idle. |
| Server | No stored shop sessions. No server-to-shop HTTP. Ingest is the existing member-token path. |

This build’s `extension/background.js` still snapshots `outerHTML`. The follow-on deletes that path.

### 17.4 Match

Same triangulate rules as §7.1 / §16: Taobao CNY orders ↔ SGD `ALIPAY*TAOBAO` (and Pinduoduo descriptors **from wallet rows only**) within 2 % FX and ±2 days. `proposed_split` when an order has 2+ items. Snippet uses item names only.

### 17.5 Fixtures

| Page | Fixture |
| --- | --- |
| Taobao 已买到的宝贝 | `fixtures/context/taobao-bought-items.json` → order `TB20261012001`, CNY 101.50, two items |
| Lazada order history | `fixtures/context/lazada-order-list.json` |
| Shopee purchase list | `fixtures/context/shopee-order-list.json` |
| Pinduoduo | **none** — `pageIsObservableOrderList` is false |

Tests: `tests/unit/order-list-observe.test.ts`.

## 18. Webhook API

Public ingest for other couples and self-hosters. Same internal event pipeline as receipt email, the Chrome extension, OwnTracks (place visits), and queued wallet import. **Webhooks never set balances or create ledger rows.** `txn_alert` is provisional evidence (`observations.is_statement = 0`, adapter `webhook-alert`). Bank statements stay the source of truth. Events appear as `/pipeline` node `source:webhook` and feed `triangulate`.

### 18.1 Create a hook

Settings → Connections → **Webhooks** → create hook. One or more hooks per household member, each with its own URL and secret (shown once). Copy them into Shortcuts, Tasker, n8n, or a shop automation. Disconnect deletes that hook (and, optionally, webhook-sourced orders / visits).

URL: `https://<host>/api/hooks/<hookId>`

Put this path on Cloudflare Access **Bypass** (`api/hooks/*`) as in §13.2. The app JWT middleware already skips it.

When `CONTEXT_WEBHOOK` is off, a correctly authenticated request still returns **404 empty**. Unknown hook, bad signature, bad bearer, and replay return **401 empty** — no hint which failed.

### 18.2 Auth

Two options; both use the secret shown once on Connections.

**HMAC-SHA256** (preferred)

| Header | Value |
| --- | --- |
| `X-OE-Hook-Timestamp` | Unix time in **seconds** |
| `X-OE-Hook-Signature` | `sha256=<hex>` of HMAC-SHA256(`<timestamp>.<raw body>`, secret) |

Reject if `|now − timestamp| > 300` seconds (replay window). Reusing the same signature inside that window also returns **401 empty**.

**Bearer** (iOS Shortcuts, Tasker, n8n)

```
Authorization: Bearer <secret>
```

No timestamp. Replay of the same payload is handled by idempotency (§18.5), not 401.

### 18.3 Limits

| Limit | Response |
| --- | --- |
| Body > 256 KiB | `413` empty |
| More than 60 POSTs / minute / hook | `429` empty |
| Auth / unknown hook / replay | `401` empty |
| Flag off (after auth) | `404` empty |
| Accepted (including duplicate) | `202` `{ "accepted": N, "duplicate"?: true, "event_ids"?: [...] }` |

### 18.4 Typed events (version 1)

`Content-Type: application/json`. Send one object, `{ "events": [ ... ] }`, or an array. Each event:

```json
{
  "type": "order",
  "version": 1,
  "event_id": "optional-idempotency-key",
  "merchant": "lazada",
  "order_id": "LZ20261012042",
  "placed_at": "2026-10-12T10:04:00+08:00",
  "currency": "SGD",
  "total": 12.90,
  "items": [{ "name": "USB-C cable", "qty": 1, "unit_price": 12.90 }]
}
```

| `type` | Fields | What we keep |
| --- | --- | --- |
| `order` | `merchant`, `order_id`, `placed_at`, `currency`, `total`, `items[{name, qty, unit_price}]` | `orders` + `order_items`. Source `webhook`. Does **not** create a bank observation. |
| `txn_alert` | `account_hint`, `merchant`, `amount`, `currency`, `at` | Observation, `is_statement = 0`, adapter `webhook-alert`. Attaches to an existing statement row when merchant/amount/date match; **never INSERT transactions**. |
| `place_visit` | `place_name`, `lat?`, `lng?`, `arrived_at`, `left_at?` | `place_visits` (`place_source = webhook`). Same table OwnTracks clusters write. |
| `calendar_event` | `title`, `location?`, `starts_at`, `ends_at?` | `calendar_events`. Same table iCal poll writes. |
| `note` | `text`, `match?: { merchant, amount, at, account_hint }` | `context_links.kind = note` when match hints hit a ledger row. |

`total` / `amount` / `unit_price` are major units (dollars). Unix seconds or ISO-8601 for timestamps. `event_id` is optional.

Synthetic fixtures: `fixtures/context/webhook-order.json`, `webhook-txn-alert.json`.

### 18.5 Mapping any JSON

If the body is not already a typed event, set a **mapping template** on the hook (Connections textarea). JSONPath (`$.a.b[0].c`) plus an items block:

```json
{
  "type": "order",
  "version": 1,
  "event_id": "$.id",
  "merchant": "$.shop",
  "order_id": "$.id",
  "placed_at": "$.created",
  "currency": "$.currency",
  "total": "$.grand_total",
  "items": {
    "from": "$.lines",
    "name": "$.title",
    "qty": "$.quantity",
    "unit_price": "$.price"
  }
}
```

Strings that do not start with `$` are literals. The card previews the mapping against the **last received sample**. Fixture: `fixtures/context/webhook-mapped-shop.json` + `webhook-mapping.json`.

Raw bodies stay 30 days (`ingest_hook_events`) so you can change the mapping and re-process conceptually against the stored sample (new POSTs use the new mapping; duplicates of the same `event_id` / body hash do not re-write).

### 18.6 Idempotency

`event_id` if present, otherwise SHA-256 of the raw body, unique per hook. Second delivery → `202 { "accepted": 0, "duplicate": true }` (not 401).

### 18.7 Examples

Bearer (Shortcuts / Tasker / n8n):

```bash
curl -sS -X POST https://<host>/api/hooks/<hookId> \
  -H 'Authorization: Bearer <secret>' \
  -H 'Content-Type: application/json' \
  -d '{"type":"order","version":1,"event_id":"test-1","merchant":"lazada","order_id":"LZ-TEST-001","placed_at":"2026-10-12T10:00:00+08:00","currency":"SGD","total":12.90,"items":[{"name":"USB-C cable","qty":1,"unit_price":12.90}]}'
```

HMAC (signature = hex HMAC-SHA256 of `<timestamp>.<raw body>`):

```bash
ts=$(date +%s)
body='{"type":"txn_alert","version":1,"merchant":"LAZADA SG","amount":-12.90,"currency":"SGD","at":"2026-10-12T10:05:00+08:00"}'
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac '<secret>' | awk '{print $NF}')
curl -sS -X POST https://<host>/api/hooks/<hookId> \
  -H "X-OE-Hook-Timestamp: $ts" \
  -H "X-OE-Hook-Signature: sha256=$sig" \
  -H 'Content-Type: application/json' \
  -d "$body"
```

iOS Shortcuts: **Get Contents of URL** → Method POST → URL the hook URL → Headers `Authorization: Bearer <secret>` and `Content-Type: application/json` → Request Body JSON (the typed event). Successful publish is HTTP **202**.

### 18.8 Tests

`tests/unit/webhook-ingest.test.ts` — signature, replay window, signature reuse, bearer idempotency, JSONPath mapping, txn_alert does not create transactions. Rate-limit test may skip.
