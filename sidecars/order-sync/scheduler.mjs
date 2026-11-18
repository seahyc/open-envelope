// Quiet scheduling for order sync: a charge triggers one fetch for that shop after a short
// human-like delay; a low-frequency sweep with jitter catches anything missed. Per-shop
// minimum gap, triggers coalesce, and only one browser runs at a time.
export class Scheduler {
  constructor({
    shops,
    run,
    minGapMs = 20 * 60 * 1000,
    triggerDelayMs = [45 * 1000, 180 * 1000],
    sweepEveryMs = 8 * 60 * 60 * 1000,
    sweepJitter = 0.25,
    sweepStaggerMs = 10 * 60 * 1000,
    random = Math.random,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = () => {},
  }) {
    Object.assign(this, { shops: new Set(shops), run, minGapMs, triggerDelayMs, sweepEveryMs, sweepJitter, sweepStaggerMs, random, now, setTimer, clearTimer, log });
    this.lastRunAt = new Map();
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.sweepTimer = null;
  }

  between([min, max]) {
    return Math.round(min + this.random() * (max - min));
  }

  /** Ask for a fetch of one shop. Returns { scheduled, at } or { scheduled: false, reason }. */
  trigger(shop, reason = 'charge') {
    if (!this.shops.has(shop)) return { scheduled: false, reason: 'unknown shop' };
    const existing = this.pending.get(shop);
    if (existing) return { scheduled: true, at: existing.at, coalesced: true };
    const delay = reason === 'sweep' ? this.between([0, this.sweepStaggerMs]) : this.between(this.triggerDelayMs);
    const earliest = (this.lastRunAt.get(shop) ?? -Infinity) + this.minGapMs;
    const at = Math.max(this.now() + delay, earliest);
    const timer = this.setTimer(() => {
      this.pending.delete(shop);
      this.queue = this.queue.then(async () => {
        this.lastRunAt.set(shop, this.now());
        try {
          await this.run(shop, reason);
        } catch (error) {
          this.log(`${shop}: run failed (${error instanceof Error ? error.message : String(error)})`);
        }
      });
    }, Math.max(0, at - this.now()));
    this.pending.set(shop, { at, timer, reason });
    return { scheduled: true, at };
  }

  startSweeps() {
    const next = () => {
      const spread = this.sweepEveryMs * this.sweepJitter;
      const wait = Math.round(this.sweepEveryMs - spread + this.random() * 2 * spread);
      this.sweepTimer = this.setTimer(() => {
        for (const shop of this.shops) this.trigger(shop, 'sweep');
        next();
      }, wait);
    };
    next();
  }

  stop() {
    if (this.sweepTimer) this.clearTimer(this.sweepTimer);
    for (const { timer } of this.pending.values()) this.clearTimer(timer);
    this.pending.clear();
  }

  idle() {
    return this.queue;
  }
}
