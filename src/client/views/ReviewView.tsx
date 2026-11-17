import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { api, apiPost, ApiClientError } from '../api';
import { formatListDate, formatSignedSgd, percentInt } from '../format';
import { Penny } from '../components/Penny';
import { BracketBar } from '../components/BracketBar';
import { PixelIcon, categoryIconName } from '../components/PixelIcon';
import { PixelStar, RainbowDigits, RewardBurst } from '../components/PixelStar';

interface ContextSnippet {
  id: string;
  kind: 'order' | 'place' | 'calendar';
  snippet: string;
  sourceId: string;
  proposedSplit: Array<{ name: string; qty: number; lineCents: number | null }> | null;
  memberName: string | null;
}

interface PayeeNote {
  payeeLabel: string;
  project: string | null;
  categoryId: string | null;
}

interface ReviewEntity {
  registeredName: string;
  ssicDescription: string | null;
  address: string | null;
  registeredLabel: string | null;
  sourceUrl: string | null;
  sourceLabel: string;
}

interface ReviewItem {
  id: string;
  reason: string;
  merchantText: string;
  merchantKey: string;
  amountCents: number | null;
  timestamp: number | null;
  accountName: string | null;
  suggestedCategoryId: string | null;
  suggestedCategoryLabel: string | null;
  confidence: number | null;
  enrichmentLine: string | null;
  enrichmentSource: 'acra' | 'web' | null;
  enrichmentUrls: string[];
  probablyWas: string;
  entity: ReviewEntity | null;
  thatDay: string;
  suggestedPayee: string;
  suggestedReason: string;
  researchPending: boolean;
  contextSnippets: ContextSnippet[];
  spentBy: string | null;
  opaque: boolean;
  payeeName: string;
  uen: string | null;
  payeeNote: PayeeNote | null;
  showPayeeNotes: boolean;
  showCapitalTransfer: boolean;
}

interface ReviewGroup {
  merchantKey: string;
  merchantText: string;
  count: number;
  suggestedCategoryId: string | null;
  suggestedCategoryLabel: string | null;
  confidence: number | null;
  items: ReviewItem[];
}

interface Category {
  id: string;
  label: string;
}

function PayeeNotesCard({
  item,
  onSaved,
}: {
  item: ReviewItem;
  onSaved: (message: string, undoId: string) => void;
}) {
  const [payeeLabel, setPayeeLabel] = useState(item.payeeNote?.payeeLabel ?? item.suggestedPayee ?? '');
  const [project, setProject] = useState(item.payeeNote?.project ?? '');
  const [payeeError, setPayeeError] = useState<string | null>(null);

  async function savePayee() {
    setPayeeError(null);
    try {
      const result = await apiPost<{ undoId: string }>(`/api/review/${item.id}/payee-note`, {
        payeeLabel,
        project: project.trim() || undefined,
      });
      onSaved('Tagged payee', result.undoId);
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === 'session') return;
      setPayeeError(err instanceof Error ? err.message : 'nothing saved');
    }
  }

  async function markCapital() {
    setPayeeError(null);
    try {
      const result = await apiPost<{ undoId: string }>(`/api/review/${item.id}/payee-note`, {
        capitalTransfer: true,
      });
      onSaved('Capital transfer', result.undoId);
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === 'session') return;
      setPayeeError(err instanceof Error ? err.message : 'nothing saved');
    }
  }

  if (!item.showPayeeNotes && !item.showCapitalTransfer) return null;

  if (!item.showPayeeNotes) {
    return (
      <div className="review-payee" data-testid="review-payee-capital-only">
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="review-payee-capital"
          onClick={() => void markCapital()}
        >
          mark as capital transfer
        </button>
        {payeeError ? (
          <p className="error-card" role="alert" data-testid="review-payee-error">
            ✕ {payeeError}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="review-payee"
      data-testid="review-payee"
      onSubmit={(event) => {
        event.preventDefault();
        void savePayee();
      }}
    >
      <p className="review-payee-heading">Tag this payee</p>
      {item.payeeName ? (
        <p className="review-meta">
          {item.payeeName}
          {item.uen ? ` · ${item.uen}` : ''}
        </p>
      ) : null}
      <label className="review-payee-field">
        <span>Payee</span>
        <input
          className="input"
          data-testid="review-payee-label"
          value={payeeLabel}
          onChange={(event) => setPayeeLabel(event.target.value)}
          placeholder={item.suggestedPayee || 'Payee name'}
        />
      </label>
      <label className="review-payee-field">
        <span>Project</span>
        <input
          className="input"
          data-testid="review-payee-project"
          value={project}
          onChange={(event) => setProject(event.target.value)}
          placeholder="Optional project"
        />
      </label>
      {item.suggestedPayee ? (
        <div className="chip-row">
          <button
            type="button"
            className="chip"
            data-testid="review-payee-suggest"
            onClick={() => setPayeeLabel(item.suggestedPayee)}
          >
            {item.suggestedPayee}
          </button>
        </div>
      ) : null}
      <div className="chip-row">
        <button type="submit" className="btn" data-testid="review-payee-save">
          save tag
        </button>
      </div>
      {item.showCapitalTransfer ? (
        <div className="chip-row">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="review-payee-capital"
            onClick={() => void markCapital()}
          >
            mark as capital transfer
          </button>
        </div>
      ) : null}
      {payeeError ? (
        <p className="error-card" role="alert" data-testid="review-payee-error">
          ✕ {payeeError}
        </p>
      ) : null}
    </form>
  );
}

export function ReviewView({ onBudget }: { onBudget: () => void }) {
  const [groups, setGroups] = useState<ReviewGroup[]>([]);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [always, setAlways] = useState(false);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; undoId: string | null; reward?: boolean } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const touchX = useRef<number | null>(null);
  const [enrichingId, setEnrichingId] = useState<string | null>(null);
  const enrichTried = useRef(new Set<string>());

  const load = useCallback(async () => {
    setError(null);
    try {
      const [review, cats] = await Promise.all([
        api<{ groups: ReviewGroup[]; items: ReviewItem[]; count: number }>('/api/review'),
        api<{ categories: Category[] }>('/api/categories'),
      ]);
      setGroups(review.groups);
      setItems(review.items);
      setCategories(cats.categories);
      setIndex((current) => Math.min(current, Math.max(0, review.items.length - 1)));
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === 'session') return;
      setError(err instanceof Error ? err.message : 'Could not load review');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 300);
    void load();
    return () => window.clearTimeout(timer);
  }, [load]);

  const current = items[index] ?? null;
  const group = current ? groups.find((entry) => entry.merchantKey === current.merchantKey) : undefined;

  useEffect(() => {
    if (!current) return;
    if (!current.researchPending && current.enrichmentLine) return;
    if (!current.researchPending && !current.opaque && !current.uen) return;
    if (!current.researchPending) return;
    if (enrichTried.current.has(current.id)) return;
    enrichTried.current.add(current.id);
    const id = current.id;
    let cancelled = false;
    setEnrichingId(id);
    apiPost<ReviewItem>(`/api/review/${id}/enrich`, {})
      .then((item) => {
        if (cancelled) return;
        setItems((prev) => prev.map((row) => (row.id === item.id ? { ...row, ...item } : row)));
        setGroups((prev) => prev.map((entry) => {
          if (entry.merchantKey !== item.merchantKey) return entry;
          const nextItems = entry.items.map((row) => (row.id === item.id ? { ...row, ...item } : row));
          const best = nextItems.reduce(
            (lead, row) => ((row.confidence ?? 0) > (lead.confidence ?? 0) ? row : lead),
            nextItems[0]!
          );
          return {
            ...entry,
            items: nextItems,
            suggestedCategoryId: best.suggestedCategoryId,
            suggestedCategoryLabel: best.suggestedCategoryLabel,
            confidence: best.confidence,
            merchantText: best.merchantText || entry.merchantText,
          };
        }));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setEnrichingId((value) => (value === id ? null : value));
      });
    return () => {
      cancelled = true;
    };
  }, [current]);
  const total = items.length;
  const chips = useMemo(() => {
    const suggested = current?.suggestedCategoryId
      ? categories.filter((cat) => cat.id === current.suggestedCategoryId)
      : [];
    const rest = categories.filter((cat) => cat.id !== current?.suggestedCategoryId);
    return [...suggested, ...rest].slice(0, 3);
  }, [categories, current]);

  function showToast(message: string, undoId: string | null, reward = false) {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ message, undoId, reward });
    toastTimer.current = window.setTimeout(() => setToast(null), undoId ? 10000 : 4000);
  }

  async function accept(categoryId: string | null, bulk: boolean) {
    if (!current || !categoryId) return;
    try {
      if (bulk && group) {
        const result = await apiPost<{ undoId: string; accepted: number }>('/api/review/bulk', {
          ids: group.items.map((item) => item.id),
          categoryId,
          rememberRule: always,
        });
        showToast(`Accepted ${result.accepted}`, result.undoId, true);
      } else {
        const result = await apiPost<{ undoId: string }>(`/api/review/${current.id}/resolve`, {
          categoryId,
          rememberRule: always && (group?.count ?? 1) > 1,
        });
        const lastInGroup = (group?.count ?? 1) <= 1;
        showToast('Accepted', result.undoId, lastInGroup);
      }
      await load();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        showToast('Sam did this one', null);
        await load();
        return;
      }
      if (err instanceof ApiClientError && err.kind === 'session') return;
      setError(err instanceof Error ? err.message : 'Accept failed');
    }
  }

  async function skip() {
    if (!current) return;
    try {
      const result = await apiPost<{ undoId: string }>(`/api/review/${current.id}/resolve`, { skip: true });
      showToast('Skipped', result.undoId);
      await load();
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === 'session') return;
      setError(err instanceof Error ? err.message : 'Skip failed');
    }
  }

  async function undo() {
    if (!toast?.undoId) return;
    try {
      await apiPost('/api/review/undo', { undoId: toast.undoId });
      setToast(null);
      await load();
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === 'session') return;
      setError(err instanceof Error ? err.message : 'Undo failed');
    }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        if (event.key === 'Escape') setSearchOpen(false);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void accept(current?.suggestedCategoryId ?? chips[0]?.id ?? null, false);
      } else if (event.key === 's') {
        event.preventDefault();
        void skip();
      } else if (event.key === 'u') {
        event.preventDefault();
        void undo();
      } else if (event.key === 'j' || event.key === 'ArrowDown') {
        setIndex((value) => Math.min(items.length - 1, value + 1));
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        setIndex((value) => Math.max(0, value - 1));
      } else if (event.key === '/') {
        event.preventDefault();
        setSearchOpen(true);
      } else if (/^[1-9]$/.test(event.key)) {
        const chip = chips[Number(event.key) - 1];
        if (chip) void accept(chip.id, false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function onTouchStart(event: TouchEvent) {
    touchX.current = event.changedTouches[0]?.clientX ?? null;
  }

  function onTouchEnd(event: TouchEvent) {
    const start = touchX.current;
    const end = event.changedTouches[0]?.clientX;
    touchX.current = null;
    if (start == null || end == null) return;
    const dx = end - start;
    if (dx > 60) void accept(current?.suggestedCategoryId ?? chips[0]?.id ?? null, false);
    if (dx < -60) void skip();
  }

  if (loading) {
    return slow ? <div className="skeleton" role="status">░░░░░░░░░░░░░░░░░░░░</div> : null;
  }

  if (error) {
    return (
      <div className="error-card" role="alert" data-testid="review-error">
        ✕ {error}
        <div><button type="button" className="btn btn-secondary" onClick={() => { setLoading(true); void load(); }}>retry</button></div>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="empty-state" data-testid="review-empty">
        <RewardBurst />
        <Penny mood="fed" caption="Nothing to check. Penny approves." />
        <p className="penny-caption">Nothing to check. Penny approves.</p>
        <RainbowDigits text="0 to check" />
        <BracketBar ratio={1} tone="rainbow" />
        <button type="button" className="btn" onClick={onBudget}>go budget</button>
      </div>
    );
  }

  const confidence = current.confidence ?? 0;
  const extraContext = (current.contextSnippets ?? []).filter(
    (snippet) => snippet.kind !== 'calendar' && snippet.kind !== 'place'
  );
  const filtered = searchOpen
    ? categories.filter((cat) => cat.label.toLowerCase().includes(search.toLowerCase())).slice(0, 8)
    : [];
  const progress = total === 0 ? 0 : (index + 1) / total;

  return (
    <div data-testid="review-shell">
      <header className="header">
        <h1>Review</h1>
        <p>
          {index + 1} / {total}{' '}
          <BracketBar ratio={progress} cells={8} tone="fill" />
        </p>
      </header>

      <div className="review-layout desktop">
        <div className="group-list" data-testid="review-groups">
          {groups.map((entry) => (
            <button
              key={entry.merchantKey}
              type="button"
              className={entry.merchantKey === current.merchantKey ? 'active' : ''}
              onClick={() => {
                const next = items.findIndex((item) => item.merchantKey === entry.merchantKey);
                if (next >= 0) setIndex(next);
              }}
            >
              <span className="group-title">
                <PixelIcon name={categoryIconName(entry.suggestedCategoryLabel)} active />
                {entry.merchantText} ×{entry.count}
              </span>
              <div className="review-meta">
                {entry.items.some((row) => row.researchPending)
                  ? 'Researching…'
                  : `${entry.suggestedCategoryLabel ?? '?'} ${entry.confidence != null ? percentInt(entry.confidence) : ''}`}
              </div>
            </button>
          ))}
        </div>

        <div>
          {group && group.count > 1 ? (
            <div className="bulk-banner" data-testid="review-bulk">
              <p>{group.merchantText} ×{group.count} in queue</p>
              <p>All → {group.suggestedCategoryLabel ?? 'this category'}?</p>
              <div className="chip-row">
                <button type="button" className="btn" onClick={() => void accept(group.suggestedCategoryId ?? current.suggestedCategoryId, true)}>
                  accept all {group.count}
                </button>
                <label>
                  <input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} /> always
                </label>
              </div>
            </div>
          ) : null}

          <div
            className="review-card"
            data-testid="review-card"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
          >
            <div className="merchant">{current.merchantText}</div>
            <div className="money">{current.amountCents == null ? '—' : formatSignedSgd(current.amountCents)}</div>
            <div className="review-meta">
              {current.timestamp ? formatListDate(current.timestamp) : ''}
              {current.accountName ? ` · ${current.accountName}` : ''}
            </div>
            {current.probablyWas ? (
              <div className="review-probably" data-testid="review-probably-was">
                <span className="kicker">What this probably was</span>
                <p>{current.probablyWas}</p>
              </div>
            ) : null}
            {current.entity ? (
              <div className="review-entity" data-testid="review-entity">
                <p className="review-entity-name">{current.entity.registeredName}</p>
                {current.entity.ssicDescription ? (
                  <p className="review-meta">{current.entity.ssicDescription}</p>
                ) : null}
                {current.entity.address ? (
                  <p className="review-meta">{current.entity.address}</p>
                ) : null}
                {current.entity.registeredLabel ? (
                  <p className="review-meta">{current.entity.registeredLabel}</p>
                ) : null}
                {current.entity.sourceUrl ? (
                  <p className="review-meta">
                    <a
                      href={current.entity.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="review-entity-source"
                    >
                      {current.entity.sourceLabel}
                    </a>
                  </p>
                ) : null}
              </div>
            ) : current.enrichmentLine ? (
              <p className="enrichment-line" data-testid="review-enrichment">
                {current.enrichmentLine}
                {current.enrichmentSource === 'web' && current.enrichmentUrls[0] ? (
                  <>
                    {' · '}
                    <a
                      href={current.enrichmentUrls[0]}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="review-entity-source"
                    >
                      {current.enrichmentUrls[0].replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            <p
              className={`review-that-day${current.thatDay.includes('nothing on your calendars') ? ' is-empty' : ''}`}
              data-testid="review-that-day"
            >
              {current.thatDay}
            </p>
            <PayeeNotesCard
              key={`${current.id}-${current.suggestedPayee}`}
              item={current}
              onSaved={(message, undoId) => {
                showToast(message, undoId);
                void load();
              }}
            />
            {current.spentBy || extraContext.length > 0 ? (
              <div className="review-context" data-testid="review-context">
                {current.spentBy ? <p className="review-context-who">{current.spentBy} spent</p> : null}
                {extraContext.map((snippet) => (
                  <p key={snippet.id || snippet.sourceId} className="review-context-line">
                    {snippet.snippet}
                  </p>
                ))}
                {extraContext.filter((snippet) => (snippet.proposedSplit ?? []).length > 1).map((snippet) => (
                  <button
                    key={`${snippet.id}-split`}
                    type="button"
                    className="chip"
                    data-testid="review-split"
                    onClick={() => {
                      void apiPost(`/api/context/links/${snippet.id}/confirm`, { split: true }).then(() => load());
                    }}
                  >
                    split into {snippet.proposedSplit!.length} items
                  </button>
                ))}
              </div>
            ) : null}
            {current.researchPending || enrichingId === current.id ? (
              <p className="guess-line" data-testid="review-researching">Researching…</p>
            ) : (
              <>
                <p className="guess-line">
                  <PixelIcon name={categoryIconName(current.suggestedCategoryLabel)} active />
                  guess {current.suggestedCategoryLabel ?? 'none'}
                  {current.confidence != null ? ` ${percentInt(current.confidence)}` : ''}
                </p>
                {current.suggestedReason ? (
                  <p className="review-meta" data-testid="review-guess-reason">{current.suggestedReason}</p>
                ) : null}
                <BracketBar ratio={confidence} tone="fill" label={percentInt(confidence)} />
              </>
            )}
            <div className="chip-row">
              {chips.map((chip, chipIndex) => (
                <button
                  key={chip.id}
                  type="button"
                  className={`chip ${chip.id === current.suggestedCategoryId ? 'active' : ''}`}
                  onClick={() => void accept(chip.id, false)}
                >
                  <PixelIcon name={categoryIconName(chip.label)} active />
                  {chipIndex + 1} {chip.label.split(' ▸ ').slice(-1)[0]}
                </button>
              ))}
              <button type="button" className="chip" onClick={() => setSearchOpen(true)}>/</button>
            </div>
            {searchOpen ? (
              <div>
                <input
                  className="input"
                  autoFocus
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="search category"
                />
                {filtered.map((cat) => (
                  <button key={cat.id} type="button" className="chip" onClick={() => void accept(cat.id, false)}>
                    <PixelIcon name={categoryIconName(cat.label)} active />
                    {cat.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="chip-row">
              <button type="button" className="btn" onClick={() => void accept(current.suggestedCategoryId ?? chips[0]?.id ?? null, false)}>
                accept
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => void skip()}>skip</button>
            </div>
            <p className="help">swipe → accept · ← skip · ⏎ accept · s skip · u undo · / search</p>
          </div>
        </div>
      </div>

      {toast ? (
        <div className="toast" role="status">
          {toast.reward ? <PixelStar /> : null}
          <span>{toast.message}</span>
          {toast.undoId ? (
            <button type="button" className="btn btn-secondary" onClick={() => void undo()}>undo</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
