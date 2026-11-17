import { useCallback, useEffect, useState } from 'react';
import { api, apiPost, ApiClientError } from '../api';
import { PixelIcon } from '../components/PixelIcon';

type Status = 'unset' | 'waiting' | 'healthy' | 'stale' | 'error';
type Kind = 'email' | 'calendar' | 'location' | 'extension' | 'webhook';

interface HookCard {
  id: string;
  name: string;
  url: string;
  lastReceivedAt: number | null;
  receivedCount: number;
  errorCount: number;
  error: string | null;
  mapping: string;
  lastSample: string | null;
  preview: unknown;
  previewError: string | null;
}

interface SourceCard {
  kind: Kind;
  status: Status;
  flagOn: boolean;
  lastReceivedAt: number | null;
  count: number;
  error: string | null;
  setup: Record<string, string | null>;
  hooks?: HookCard[];
}

interface Snapshot {
  member: { id: string; name: string; email: string; slug: string };
  ingestDomain: string;
  gmailFilter: string;
  owntracksUrl: string;
  staleAfterDays: number;
  sources: SourceCard[];
}

const TITLES: Record<Kind, string> = {
  email: 'Alerts & receipts',
  calendar: 'Calendar',
  location: 'Location (OwnTracks)',
  extension: 'Browser extension',
  webhook: 'Webhooks',
};

const ICONS: Record<Kind, string> = {
  email: 'retail',
  calendar: 'star',
  location: 'home',
  extension: 'accounts',
  webhook: 'transfer',
};

const TEST_ORDER = {
  type: 'order',
  version: 1,
  event_id: 'test-lazada-001',
  merchant: 'lazada',
  order_id: 'LZ-TEST-001',
  placed_at: '2026-10-12T10:00:00+08:00',
  currency: 'SGD',
  total: 12.9,
  items: [{ name: 'USB-C cable', qty: 1, unit_price: 12.9 }],
};

const STATUS_LABEL: Record<Status, string> = {
  unset: 'not set up',
  waiting: 'waiting for first data',
  healthy: 'healthy',
  stale: 'stale',
  error: 'error',
};

function formatWhen(ts: number | null): string {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short' });
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function ConnectionsView() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [icalUrl, setIcalUrl] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api<Snapshot>('/api/connections');
      setSnap(data);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load connections.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function flash(id: string) {
    setCopied(id);
    window.setTimeout(() => setCopied((cur) => (cur === id ? null : cur)), 1500);
  }

  async function onCopy(id: string, value: string) {
    if (await copyText(value)) void flash(id);
  }

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  }

  if (!snap && !error) {
    return <div className="skeleton" data-testid="connections-shell" role="status">░░░░░░░░░░░░░░░░░░░░</div>;
  }

  return (
    <div data-testid="connections-shell" className="connections-page">
      <header className="connections-head">
        <h1>Connections</h1>
        {snap ? (
          <p className="connections-who">
            {snap.member.name}
            {snap.member.email ? ` · ${snap.member.email}` : ''}
          </p>
        ) : null}
        <p className="connections-lead">
          Wire receipts, calendar, location, the shop extension, and webhooks — only your sources, never your partner&apos;s.
        </p>
        <p className="help">
          Your partner will not see this feed; they may see a place name or shop on a transaction you both share.
        </p>
      </header>
      {error ? <div className="error-card" role="alert">{error}</div> : null}
      {snap?.sources.map((source) => {
        const title = TITLES[source.kind];
        return (
          <article
            key={source.kind}
            className="card conn-card"
            data-testid={`conn-${source.kind}`}
            data-status={source.status}
          >
            <header className="conn-card-head">
              <PixelIcon name={ICONS[source.kind]} title={title} />
              <h2>{title}</h2>
              <span className={`badge badge-${source.status}`}>{STATUS_LABEL[source.status]}</span>
            </header>
            {!source.flagOn ? <p className="conn-muted">Server flag off — ingest paused.</p> : null}
            <p className="conn-meta">
              Last data {formatWhen(source.lastReceivedAt)}
              {source.count ? ` · ${source.count}` : ''}
            </p>
            {source.error ? <p className="conn-error">{source.error}</p> : null}
            {source.kind === 'email' ? (
              <EmailSetup
                source={source}
                domain={snap.ingestDomain}
                gmailFilter={snap.gmailFilter}
                busy={busy}
                copied={copied}
                onCopy={onCopy}
                onEnable={() => act('email', async () => { await apiPost('/api/connections/email', {}); })}
                onRegenerate={() => act('email-regen', async () => { await apiPost('/api/connections/email/regenerate', {}); })}
                onDisconnect={() => act('email-off', async () => {
                  await apiPost('/api/connections/email/disconnect', { deleteData: true });
                })}
              />
            ) : null}
            {source.kind === 'calendar' ? (
              <CalendarSetup
                source={source}
                icalUrl={icalUrl}
                setIcalUrl={setIcalUrl}
                busy={busy}
                onSave={() => act('calendar', async () => {
                  await apiPost('/api/connections/calendar', { url: icalUrl });
                  setIcalUrl('');
                })}
                onDisconnect={() => act('calendar-off', async () => {
                  await apiPost('/api/connections/calendar/disconnect', { deleteData: true });
                })}
              />
            ) : null}
            {source.kind === 'location' ? (
              <LocationSetup
                source={source}
                url={snap.owntracksUrl}
                secret={secrets.location}
                busy={busy}
                copied={copied}
                onCopy={onCopy}
                onMint={() => act('location', async () => {
                  const minted = await apiPost<{ deviceId: string; secret: string; url: string }>(
                    '/api/connections/location',
                    {},
                  );
                  setSecrets((cur) => ({ ...cur, location: minted.secret }));
                })}
                onDisconnect={() => act('location-off', async () => {
                  await apiPost('/api/connections/location/disconnect', { deleteData: true });
                  setSecrets((cur) => ({ ...cur, location: '' }));
                })}
              />
            ) : null}
            {source.kind === 'extension' ? (
              <ExtensionSetup
                source={source}
                token={secrets.extension}
                busy={busy}
                copied={copied}
                onCopy={onCopy}
                onMint={() => act('extension', async () => {
                  const minted = await apiPost<{ token: string; ingestUrl: string }>(
                    '/api/connections/extension',
                    {},
                  );
                  setSecrets((cur) => ({ ...cur, extension: minted.token }));
                })}
                onDisconnect={() => act('extension-off', async () => {
                  await apiPost('/api/connections/extension/disconnect', { deleteData: true });
                  setSecrets((cur) => ({ ...cur, extension: '' }));
                })}
              />
            ) : null}
            {source.kind === 'webhook' ? (
              <WebhookSetup
                source={source}
                secrets={secrets}
                busy={busy}
                copied={copied}
                onCopy={onCopy}
                onCreate={() => act('webhook', async () => {
                  const minted = await apiPost<{ id: string; secret: string; url: string; name: string }>(
                    '/api/connections/webhooks',
                    { name: 'Webhook' },
                  );
                  setSecrets((cur) => ({ ...cur, [`hook-${minted.id}`]: minted.secret, [`hook-url-${minted.id}`]: minted.url }));
                })}
                onSaveMapping={(id, mapping) => act(`map-${id}`, async () => {
                  await apiPost(`/api/connections/webhooks/${id}/mapping`, { mapping });
                })}
                onTest={(id) => act(`test-${id}`, async () => {
                  await apiPost(`/api/connections/webhooks/${id}/test`, TEST_ORDER);
                })}
                onDeleteHook={(id) => act(`hook-off-${id}`, async () => {
                  await apiPost(`/api/connections/webhooks/${id}/disconnect`, { deleteData: true });
                  setSecrets((cur) => ({ ...cur, [`hook-${id}`]: '', [`hook-url-${id}`]: '' }));
                })}
                onDisconnectAll={() => act('webhook-off', async () => {
                  await apiPost('/api/connections/webhook/disconnect', { deleteData: true });
                  setSecrets({});
                })}
              />
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function CopyRow({
  id,
  label,
  value,
  copied,
  onCopy,
}: {
  id: string;
  label: string;
  value: string;
  copied: string | null;
  onCopy: (id: string, value: string) => void;
}) {
  return (
    <div className="conn-copy">
      <span className="conn-copy-label">{label}</span>
      <code data-testid={`${id}-value`}>{value}</code>
      <button type="button" className="btn btn-secondary" data-testid={id} onClick={() => onCopy(id, value)}>
        {copied === id ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

function emailPhaseLabel(phase: string | null | undefined): string {
  if (phase === 'connected') return 'connected';
  if (phase === 'waiting_test_alert') return 'waiting for a test alert';
  if (phase === 'waiting_forwarding_confirm') return 'waiting for Gmail confirmation';
  return 'create your mailbox';
}

function EmailSetup({
  source,
  domain,
  gmailFilter,
  busy,
  copied,
  onCopy,
  onEnable,
  onRegenerate,
  onDisconnect,
}: {
  source: SourceCard;
  domain: string;
  gmailFilter: string;
  busy: string | null;
  copied: string | null;
  onCopy: (id: string, value: string) => void;
  onEnable: () => void;
  onRegenerate: () => void;
  onDisconnect: () => void;
}) {
  const address = source.setup.address;
  const phase = source.setup.emailPhase;
  const firstMailAt = source.setup.firstMailAt ? Number(source.setup.firstMailAt) : null;
  const lastParseConfidence = source.setup.lastParseConfidence;
  return (
    <div className="conn-setup">
      <p className="conn-phase" data-testid="email-phase">{emailPhaseLabel(phase)}</p>
      <ol>
        <li>Create your private ingest address. Only you can see it. Regenerating retires the old one.</li>
        <li>In Gmail: Settings → See all settings → Forwarding and POP/IMAP → Add a forwarding address. Paste the address below.</li>
        <li>Gmail emails a confirmation. The code and link appear only on this card — paste the code back in Gmail.</li>
        <li>Create a filter with the query below. Tick only “Forward it to” this address. Leave Skip Inbox and Delete unchecked so the original stays in your inbox.</li>
        <li>Send a test by forwarding an old bank alert. We mark it here when the first email arrives.</li>
      </ol>
      {address ? (
        <CopyRow id="copy-email-address" label="Forward to" value={address} copied={copied} onCopy={onCopy} />
      ) : (
        <p className="conn-muted">{domain ? 'No mailbox yet.' : 'Set EMAIL_INGEST_DOMAIN on the server first.'}</p>
      )}
      <CopyRow id="copy-gmail-filter" label="Gmail filter" value={gmailFilter} copied={copied} onCopy={onCopy} />
      {source.setup.gmailVerifyCode ? (
        <div className="conn-verify" data-testid="gmail-verify">
          <p>Gmail confirmation code</p>
          <CopyRow
            id="copy-gmail-code"
            label="Code"
            value={source.setup.gmailVerifyCode}
            copied={copied}
            onCopy={onCopy}
          />
          {source.setup.gmailVerifyLink ? (
            <CopyRow
              id="copy-gmail-link"
              label="Link"
              value={source.setup.gmailVerifyLink}
              copied={copied}
              onCopy={onCopy}
            />
          ) : null}
        </div>
      ) : null}
      <div className="conn-verify" data-testid="email-test-alert">
        {firstMailAt ? (
          <p>
            First email arrived {formatWhen(firstMailAt)}
            {source.setup.lastParseStatus ? ` · ${source.setup.lastParseStatus}` : ''}
            {source.setup.lastParseMethod ? ` · ${source.setup.lastParseMethod}` : ''}
            {lastParseConfidence ? ` · confidence ${Number(lastParseConfidence).toFixed(2)}` : ''}
          </p>
        ) : (
          <p>No test email yet. Forward an old OCBC, DBS, UOB, or other bank alert after the filter is on.</p>
        )}
      </div>
      <div className="conn-actions">
        <button type="button" className="btn" disabled={busy === 'email' || !domain} onClick={onEnable}>
          {address ? 'show mailbox' : 'create mailbox'}
        </button>
        {address ? (
          <button type="button" className="btn btn-secondary" disabled={busy === 'email-regen' || !domain} onClick={onRegenerate}>
            regenerate address
          </button>
        ) : null}
        {address ? (
          <button type="button" className="btn btn-secondary" disabled={busy === 'email-off'} onClick={onDisconnect}>
            revoke & delete my mail
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CalendarSetup({
  source,
  icalUrl,
  setIcalUrl,
  busy,
  onSave,
  onDisconnect,
}: {
  source: SourceCard;
  icalUrl: string;
  setIcalUrl: (value: string) => void;
  busy: string | null;
  onSave: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="conn-setup">
      <ol>
        <li>Google Calendar → Settings → Integrate calendar → Secret address in iCal format.</li>
        <li>Paste the https://calendar.google.com/…/basic.ics URL. We fetch once to check it, then store it encrypted.</li>
      </ol>
      <form
        className="conn-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
      >
        <label htmlFor="ical-url">Secret iCal URL</label>
        <input
          id="ical-url"
          className="input"
          data-testid="ical-url"
          type="url"
          autoComplete="off"
          placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          value={icalUrl}
          onChange={(e) => setIcalUrl(e.target.value)}
        />
        <button type="submit" className="btn" disabled={busy === 'calendar' || !icalUrl.trim()}>
          {source.setup.configured ? 'replace calendar' : 'save calendar'}
        </button>
      </form>
      {source.setup.configured ? (
        <button type="button" className="btn btn-secondary" disabled={busy === 'calendar-off'} onClick={onDisconnect}>
          disconnect & delete events
        </button>
      ) : null}
    </div>
  );
}

function LocationSetup({
  source,
  url,
  secret,
  busy,
  copied,
  onCopy,
  onMint,
  onDisconnect,
}: {
  source: SourceCard;
  url: string;
  secret?: string;
  busy: string | null;
  copied: string | null;
  onCopy: (id: string, value: string) => void;
  onMint: () => void;
  onDisconnect: () => void;
}) {
  const username = source.setup.deviceId || '';
  return (
    <div className="conn-setup">
      <ol>
        <li>OwnTracks → Mode HTTP. URL below. Authentication on. UserID = username, Password = secret.</li>
        <li>Monitoring: Significant. Leave extra headers empty — this path is Access Bypass.</li>
      </ol>
      <CopyRow id="copy-owntracks-url" label="URL" value={url} copied={copied} onCopy={onCopy} />
      {username ? <CopyRow id="copy-owntracks-user" label="Username" value={username} copied={copied} onCopy={onCopy} /> : null}
      {secret ? <CopyRow id="copy-owntracks-pass" label="Password (shown once)" value={secret} copied={copied} onCopy={onCopy} /> : null}
      <div className="conn-actions">
        <button type="button" className="btn" disabled={busy === 'location'} onClick={onMint}>
          {username ? 'rotate device secret' : 'create device'}
        </button>
        {username ? (
          <button type="button" className="btn btn-secondary" disabled={busy === 'location-off'} onClick={onDisconnect}>
            disconnect & delete points
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ExtensionSetup({
  source,
  token,
  busy,
  copied,
  onCopy,
  onMint,
  onDisconnect,
}: {
  source: SourceCard;
  token?: string;
  busy: string | null;
  copied: string | null;
  onCopy: (id: string, value: string) => void;
  onMint: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="conn-setup">
      <ol>
        <li>Chrome → chrome://extensions → Load unpacked → the repo <code>extension/</code> folder.</li>
        <li>Paste the token into the extension options. On shopee.sg or lazada.sg order history, click the toolbar button — never a background scrape.</li>
      </ol>
      {token ? <CopyRow id="copy-ext-token" label="Token (shown once)" value={token} copied={copied} onCopy={onCopy} /> : null}
      <div className="conn-actions">
        <button type="button" className="btn" disabled={busy === 'extension'} onClick={onMint}>
          {source.setup.minted ? 'rotate token' : 'create token'}
        </button>
        {source.setup.minted ? (
          <button type="button" className="btn btn-secondary" disabled={busy === 'extension-off'} onClick={onDisconnect}>
            disconnect & delete extension orders
          </button>
        ) : null}
      </div>
    </div>
  );
}

function curlExample(url: string, secret: string): string {
  return `curl -sS -X POST ${url} \\
  -H 'Authorization: Bearer ${secret || '<secret>'}' \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(TEST_ORDER)}'`;
}

function shortcutsHint(url: string): string {
  return `iOS Shortcuts: Get Contents of URL → POST ${url} → Headers Authorization: Bearer <secret> → JSON body (the test event below).`;
}

function WebhookSetup({
  source,
  secrets,
  busy,
  copied,
  onCopy,
  onCreate,
  onSaveMapping,
  onTest,
  onDeleteHook,
  onDisconnectAll,
}: {
  source: SourceCard;
  secrets: Record<string, string>;
  busy: string | null;
  copied: string | null;
  onCopy: (id: string, value: string) => void;
  onCreate: () => void;
  onSaveMapping: (id: string, mapping: string) => void;
  onTest: (id: string) => void;
  onDeleteHook: (id: string) => void;
  onDisconnectAll: () => void;
}) {
  const hooks = source.hooks ?? [];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return (
    <div className="conn-setup">
      <ol>
        <li>Create a hook. Copy the URL and secret once. One hook per automation (Shortcuts, Tasker, n8n) is fine.</li>
        <li>POST JSON to the URL. Sign with HMAC-SHA256 of timestamp + body, or send <code>Authorization: Bearer</code> with the secret.</li>
        <li>Typed events (<code>order</code>, <code>txn_alert</code>, <code>place_visit</code>, <code>calendar_event</code>, <code>note</code>) ingest as-is. Any other JSON needs a mapping template (JSONPath) on this card — preview uses the last received sample.</li>
        <li>Alerts are provisional evidence. Statements stay the source of truth. Webhooks never set balances.</li>
      </ol>
      {hooks.map((hook) => {
        const secret = secrets[`hook-${hook.id}`] || '';
        const mapping = drafts[hook.id] ?? hook.mapping;
        const previewText = hook.previewError
          ? hook.previewError
          : hook.preview
            ? JSON.stringify(hook.preview, null, 2)
            : 'No sample yet — send an event, then the mapped result appears here.';
        return (
          <section key={hook.id} className="conn-hook" data-testid={`conn-hook-${hook.id}`}>
            <h3>{hook.name}</h3>
            <p className="conn-meta">
              Last data {formatWhen(hook.lastReceivedAt)}
              {hook.receivedCount ? ` · ${hook.receivedCount} received` : ''}
              {hook.errorCount ? ` · ${hook.errorCount} errors` : ''}
            </p>
            {hook.error ? <p className="conn-error">{hook.error}</p> : null}
            <CopyRow id={`copy-hook-url-${hook.id}`} label="URL" value={hook.url} copied={copied} onCopy={onCopy} />
            {secret ? (
              <CopyRow
                id={`copy-hook-secret-${hook.id}`}
                label="Secret (shown once)"
                value={secret}
                copied={copied}
                onCopy={onCopy}
              />
            ) : (
              <p className="conn-muted">Secret is shown only when you create the hook.</p>
            )}
            <label htmlFor={`hook-map-${hook.id}`}>Mapping template</label>
            <textarea
              id={`hook-map-${hook.id}`}
              className="input conn-map"
              data-testid={`hook-mapping-${hook.id}`}
              rows={6}
              spellCheck={false}
              placeholder={'{\n  "type": "order",\n  "merchant": "$.shop",\n  "order_id": "$.id"\n}'}
              value={mapping}
              onChange={(e) => setDrafts((cur) => ({ ...cur, [hook.id]: e.target.value }))}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy === `map-${hook.id}`}
              onClick={() => onSaveMapping(hook.id, mapping)}
            >
              save mapping
            </button>
            <p className="conn-copy-label">Live preview (last sample)</p>
            <pre className="conn-preview" data-testid={`hook-preview-${hook.id}`}>{previewText}</pre>
            <p className="conn-copy-label">Send test event</p>
            <pre className="conn-preview" data-testid={`hook-curl-${hook.id}`}>{curlExample(hook.url, secret)}</pre>
            <p className="help">{shortcutsHint(hook.url)}</p>
            <div className="conn-actions">
              <button type="button" className="btn" disabled={busy === `test-${hook.id}`} onClick={() => onTest(hook.id)}>
                send test event
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy === `hook-off-${hook.id}`}
                onClick={() => onDeleteHook(hook.id)}
              >
                delete hook
              </button>
            </div>
          </section>
        );
      })}
      <div className="conn-actions">
        <button type="button" className="btn" disabled={busy === 'webhook'} onClick={onCreate}>
          create hook
        </button>
        {hooks.length > 0 ? (
          <button type="button" className="btn btn-secondary" disabled={busy === 'webhook-off'} onClick={onDisconnectAll}>
            disconnect all webhooks
          </button>
        ) : null}
      </div>
    </div>
  );
}
