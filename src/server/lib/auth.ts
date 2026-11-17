import { createPublicKey, createVerify } from 'node:crypto';
import { Context } from 'hono';
import { logger } from './logger.js';

export const AUTH_CLOCK_SKEW_SECONDS = 60;

export interface AuthConfig {
  mode: 'header' | 'none' | 'session';
  headerName: string;
  cfAccessTeamDomain?: string;
  cfAccessAud?: string;
  allowedEmails?: string[];
  accessGate?: boolean;
}

export interface RsaJwk {
  kid?: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

export interface AccessJwtPayload {
  email: string;
  aud: string | string[];
  iss: string;
  exp: number;
  nbf?: number;
  iat?: number;
}

type LookupKey = (kid: string) => Promise<RsaJwk>;

const defaultCache = new Map<string, RsaJwk>();
let defaultFetchJwks: (url: string) => Promise<{ keys: RsaJwk[] }> = fetchJwks;

export function resetJwksCache(): void {
  defaultCache.clear();
}

export function setJwksFetcher(fetcher: ((url: string) => Promise<{ keys: RsaJwk[] }>) | null): void {
  defaultFetchJwks = fetcher ?? fetchJwks;
  defaultCache.clear();
}

export function accessHost(teamDomain: string): string {
  const host = teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!host.includes('.')) {
    return `${host}.cloudflareaccess.com`;
  }
  return host;
}

export function cloudflareAccessJwksUrl(teamDomain: string): string {
  return `https://${accessHost(teamDomain)}/cdn-cgi/access/certs`;
}

export function assertProductionAuthConfig(
  config: Pick<AuthConfig, 'mode' | 'cfAccessTeamDomain' | 'cfAccessAud' | 'allowedEmails' | 'accessGate'>,
  nodeEnv: string = process.env.NODE_ENV || ''
): void {
  if (config.mode === 'none') return;
  if (nodeEnv !== 'production') return;
  if (config.mode === 'session' && !config.accessGate) return;
  if (!hasJwtConfig(config)) {
    throw new Error(
      config.mode === 'session'
        ? 'ACCESS_GATE requires CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, and ALLOWED_EMAILS in production'
        : 'AUTH_MODE=header requires CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, and ALLOWED_EMAILS in production'
    );
  }
}

function hasJwtConfig(
  config: Pick<AuthConfig, 'cfAccessTeamDomain' | 'cfAccessAud' | 'allowedEmails'>
): boolean {
  return Boolean(config.cfAccessTeamDomain && config.cfAccessAud && config.allowedEmails && config.allowedEmails.length > 0);
}

async function fetchJwks(url: string): Promise<{ keys: RsaJwk[] }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`JWKS fetch failed (${response.status})`);
  }
  return response.json() as Promise<{ keys: RsaJwk[] }>;
}

async function lookupCachedKey(jwksUrl: string, kid: string): Promise<RsaJwk> {
  const hit = defaultCache.get(kid);
  if (hit) return hit;
  const body = await defaultFetchJwks(jwksUrl);
  defaultCache.clear();
  for (const key of body.keys || []) {
    if (key.kid && key.kty === 'RSA' && key.n && key.e) {
      defaultCache.set(key.kid, key);
    }
  }
  const found = defaultCache.get(kid);
  if (!found) {
    throw new Error('unknown kid');
  }
  return found;
}

function b64urlJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function audiences(aud: unknown): string[] {
  if (typeof aud === 'string') return [aud];
  if (Array.isArray(aud)) return aud.filter((value): value is string => typeof value === 'string');
  return [];
}

function issuerMatches(iss: unknown, teamDomain: string): boolean {
  if (typeof iss !== 'string' || !iss) return false;
  let issHost = iss;
  try {
    if (iss.includes('://')) {
      issHost = new URL(iss).host;
    }
  } catch {
    return false;
  }
  return issHost === accessHost(teamDomain) || iss === teamDomain;
}

function verifyRs256(signingInput: string, signature: Buffer, jwk: RsaJwk): boolean {
  const key = createPublicKey({
    key: {
      kty: 'RSA',
      n: jwk.n,
      e: jwk.e,
    },
    format: 'jwk',
  });
  const verifier = createVerify('SHA256');
  verifier.update(signingInput);
  verifier.end();
  return verifier.verify(key, signature);
}

export async function verifyCloudflareAccessJwt(
  token: string,
  options: {
    teamDomain: string;
    audience: string;
    allowedEmails: string[];
    nowMs?: number;
    clockSkewSeconds?: number;
    lookupKey?: LookupKey;
  }
): Promise<AccessJwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Invalid JWT format');
  }

  let header: { alg?: unknown; kid?: unknown };
  try {
    header = b64urlJson(parts[0]) as { alg?: unknown; kid?: unknown };
  } catch {
    throw new Error('Invalid JWT header');
  }

  if (header.alg !== 'RS256') {
    throw new Error('Invalid JWT alg');
  }
  if (typeof header.kid !== 'string' || !header.kid) {
    throw new Error('Invalid JWT kid');
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], 'base64url');
  const jwksUrl = cloudflareAccessJwksUrl(options.teamDomain);
  const lookup = options.lookupKey ?? ((kid: string) => lookupCachedKey(jwksUrl, kid));
  const jwk = await lookup(header.kid);

  if (!verifyRs256(signingInput, signature, jwk)) {
    throw new Error('Invalid JWT signature');
  }

  let payload: Record<string, unknown>;
  try {
    payload = b64urlJson(parts[1]) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid JWT payload');
  }

  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const skew = options.clockSkewSeconds ?? AUTH_CLOCK_SKEW_SECONDS;

  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new Error('Invalid JWT exp');
  }
  if (nowSec >= payload.exp + skew) {
    throw new Error('JWT expired');
  }
  if (typeof payload.nbf === 'number' && nowSec < payload.nbf - skew) {
    throw new Error('JWT not yet valid');
  }

  if (!audiences(payload.aud).includes(options.audience)) {
    throw new Error('Invalid audience');
  }
  if (!issuerMatches(payload.iss, options.teamDomain)) {
    throw new Error('Invalid issuer');
  }
  if (typeof payload.email !== 'string' || !payload.email) {
    throw new Error('Invalid email claim');
  }
  if (!options.allowedEmails.includes(payload.email)) {
    throw new Error('Email not in allowlist');
  }

  return {
    email: payload.email,
    aud: payload.aud as string | string[],
    iss: payload.iss as string,
    exp: payload.exp,
    nbf: typeof payload.nbf === 'number' ? payload.nbf : undefined,
    iat: typeof payload.iat === 'number' ? payload.iat : undefined,
  };
}

export async function validateAuth(c: Context, config: AuthConfig): Promise<string | null> {
  if (config.mode === 'none') {
    return 'anonymous';
  }

  if (!hasJwtConfig(config)) {
    logger.error('Auth config missing for header mode');
    return null;
  }

  const jwtToken = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwtToken) {
    logger.warn('Missing Cloudflare Access JWT');
    return null;
  }

  try {
    const payload = await verifyCloudflareAccessJwt(jwtToken, {
      teamDomain: config.cfAccessTeamDomain!,
      audience: config.cfAccessAud!,
      allowedEmails: config.allowedEmails!,
    });
    return mapEmailToMember(payload.email, config.allowedEmails!);
  } catch (error) {
    logger.error('JWT validation failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export function mapEmailToMember(email: string, allowedEmails: string[]): string {
  if (allowedEmails.length >= 2) {
    if (email === allowedEmails[0]) return 'alex';
    if (email === allowedEmails[1]) return 'sam';
  }
  return email;
}

/** Reverse of mapEmailToMember. Null if the identity is not on the allowlist. */
export function emailForAccessIdentity(identity: string, allowedEmails: string[]): string | null {
  const needle = identity.trim();
  if (!needle || needle === 'anonymous') return null;
  const first = allowedEmails[0];
  const second = allowedEmails[1];
  if (first && second) {
    if (needle === 'alex' || needle === first) return first;
    if (needle === 'sam' || needle === second) return second;
  }
  return allowedEmails.find((email) => email === needle) ?? null;
}
