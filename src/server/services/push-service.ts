import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { flagOn } from '../lib/context-flags.js';
import { hh } from '../lib/tenancy.js';

export function webPushEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn('WEB_PUSH', env);
}

export class PushService {
  constructor(private db: Database.Database) {}

  vapidPublicKey(env: NodeJS.ProcessEnv = process.env): string | null {
    if (!webPushEnabled(env)) return null;
    const key = (env.VAPID_PUBLIC_KEY || '').trim();
    return key || null;
  }

  subscribe(subscription: {
    endpoint: string;
    keys?: { p256dh?: string; auth?: string };
  }): string {
    const endpoint = subscription.endpoint?.trim();
    if (!endpoint) throw new Error('endpoint is required');
    const p256dh = subscription.keys?.p256dh?.trim() || '';
    const auth = subscription.keys?.auth?.trim() || '';
    const existing = this.db.prepare(
      'SELECT id FROM push_subscriptions WHERE endpoint = ?'
    ).get(endpoint) as { id: string } | undefined;
    const id = existing?.id ?? crypto.randomBytes(8).toString('hex');
    if (existing) {
      this.db.prepare(
        'UPDATE push_subscriptions SET p256dh = ?, auth = ?, updated_at = ? WHERE id = ?'
      ).run(p256dh, auth, Date.now(), id);
      return id;
    }
    this.db.prepare(`
      INSERT INTO push_subscriptions (id, household_id, endpoint, p256dh, auth, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, hh(), endpoint, p256dh, auth, Date.now(), Date.now());
    return id;
  }

  unsubscribe(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }
}
