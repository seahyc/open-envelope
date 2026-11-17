import { describe, it, expect, beforeEach } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import type { Context } from 'hono';
import {
  accessHost,
  assertProductionAuthConfig,
  AUTH_CLOCK_SKEW_SECONDS,
  cloudflareAccessJwksUrl,
  resetJwksCache,
  setJwksFetcher,
  validateAuth,
  verifyCloudflareAccessJwt,
  type RsaJwk,
} from '../../src/server/lib/auth.js';

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'audience-123';
const EMAIL = 'alex@example.com';
const ALLOWED = ['alex@example.com', 'sam@example.com'];
const KID = 'test-kid-1';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as RsaJwk;
jwk.kid = KID;
jwk.kty = 'RSA';
jwk.alg = 'RS256';
jwk.use = 'sig';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function signToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key = privateKey
): string {
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signer = createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    email: EMAIL,
    aud: AUD,
    iss: `https://${TEAM}`,
    exp: now + 3600,
    nbf: now - 60,
    iat: now,
    ...overrides,
  };
}

function validHeader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { alg: 'RS256', kid: KID, typ: 'JWT', ...overrides };
}

async function lookup(kid: string): Promise<RsaJwk> {
  if (kid !== KID) throw new Error('unknown kid');
  return jwk;
}

function ctx(headers: Record<string, string>): Context {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lower[key.toLowerCase()] = value;
  }
  return {
    req: {
      header: (name: string) => lower[name.toLowerCase()],
    },
  } as unknown as Context;
}

const jwtConfig = {
  mode: 'header' as const,
  headerName: 'X-Auth-User',
  cfAccessTeamDomain: TEAM,
  cfAccessAud: AUD,
  allowedEmails: ALLOWED,
};

describe('Cloudflare Access JWT', () => {
  beforeEach(() => {
    resetJwksCache();
    setJwksFetcher(null);
  });

  it('accepts a valid RS256 token', async () => {
    const token = signToken(validHeader(), validPayload());
    const payload = await verifyCloudflareAccessJwt(token, {
      teamDomain: TEAM,
      audience: AUD,
      allowedEmails: ALLOWED,
      lookupKey: lookup,
    });
    expect(payload.email).toBe(EMAIL);
  });

  it('rejects a bad signature', async () => {
    const token = signToken(validHeader(), validPayload());
    const other = signToken(validHeader(), validPayload({ email: 'sam@example.com' }));
    const mixed = `${token.split('.')[0]}.${token.split('.')[1]}.${other.split('.')[2]}`;
    await expect(
      verifyCloudflareAccessJwt(mixed, {
        teamDomain: TEAM,
        audience: AUD,
        allowedEmails: ALLOWED,
        lookupKey: lookup,
      })
    ).rejects.toThrow(/signature/i);
  });

  it('rejects alg none', async () => {
    const token = `${b64url({ alg: 'none', kid: KID })}.${b64url(validPayload())}.x`;
    await expect(
      verifyCloudflareAccessJwt(token, {
        teamDomain: TEAM,
        audience: AUD,
        allowedEmails: ALLOWED,
        lookupKey: lookup,
      })
    ).rejects.toThrow(/alg/i);
  });

  it('rejects alg HS256', async () => {
    const token = signToken(validHeader({ alg: 'HS256' }), validPayload());
    await expect(
      verifyCloudflareAccessJwt(token, {
        teamDomain: TEAM,
        audience: AUD,
        allowedEmails: ALLOWED,
        lookupKey: lookup,
      })
    ).rejects.toThrow(/alg/i);
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(
      validHeader(),
      validPayload({ exp: now - AUTH_CLOCK_SKEW_SECONDS - 30 })
    );
    await expect(
      verifyCloudflareAccessJwt(token, {
        teamDomain: TEAM,
        audience: AUD,
        allowedEmails: ALLOWED,
        lookupKey: lookup,
        nowMs: now * 1000,
      })
    ).rejects.toThrow(/expired/i);
  });

  it('rejects the wrong audience', async () => {
    const token = signToken(validHeader(), validPayload({ aud: 'other-aud' }));
    await expect(
      verifyCloudflareAccessJwt(token, {
        teamDomain: TEAM,
        audience: AUD,
        allowedEmails: ALLOWED,
        lookupKey: lookup,
      })
    ).rejects.toThrow(/audience/i);
  });

  it('rejects the wrong issuer', async () => {
    const token = signToken(validHeader(), validPayload({ iss: 'https://evil.example' }));
    await expect(
      verifyCloudflareAccessJwt(token, {
        teamDomain: TEAM,
        audience: AUD,
        allowedEmails: ALLOWED,
        lookupKey: lookup,
      })
    ).rejects.toThrow(/issuer/i);
  });

  it('rejects an unknown kid', async () => {
    const token = signToken(validHeader({ kid: 'nope' }), validPayload());
    await expect(
      verifyCloudflareAccessJwt(token, {
        teamDomain: TEAM,
        audience: AUD,
        allowedEmails: ALLOWED,
        lookupKey: lookup,
      })
    ).rejects.toThrow(/unknown kid/i);
  });

  it('rejects a disallowed email', async () => {
    const token = signToken(validHeader(), validPayload({ email: 'intruder@example.com' }));
    await expect(
      verifyCloudflareAccessJwt(token, {
        teamDomain: TEAM,
        audience: AUD,
        allowedEmails: ALLOWED,
        lookupKey: lookup,
      })
    ).rejects.toThrow(/allowlist/i);
  });

  it('refreshes JWKS when the kid is unknown to the cache', async () => {
    let fetches = 0;
    setJwksFetcher(async () => {
      fetches += 1;
      if (fetches === 1) return { keys: [] };
      return { keys: [jwk] };
    });
    const token = signToken(validHeader(), validPayload());
    await expect(
      verifyCloudflareAccessJwt(token, {
        teamDomain: TEAM,
        audience: AUD,
        allowedEmails: ALLOWED,
      })
    ).rejects.toThrow(/unknown kid/i);
    expect(fetches).toBe(1);
    const payload = await verifyCloudflareAccessJwt(token, {
      teamDomain: TEAM,
      audience: AUD,
      allowedEmails: ALLOWED,
    });
    expect(payload.email).toBe(EMAIL);
    expect(fetches).toBe(2);
    await verifyCloudflareAccessJwt(token, {
      teamDomain: TEAM,
      audience: AUD,
      allowedEmails: ALLOWED,
    });
    expect(fetches).toBe(2);
  });
});

describe('validateAuth', () => {
  it('does not trust X-Auth-User or Cf-Access-Authenticated-User-Email', async () => {
    const user = await validateAuth(
      ctx({
        'X-Auth-User': EMAIL,
        'Cf-Access-Authenticated-User-Email': EMAIL,
      }),
      jwtConfig
    );
    expect(user).toBeNull();
  });

  it('returns identity only from a verified token', async () => {
    setJwksFetcher(async () => ({ keys: [jwk] }));
    const token = signToken(validHeader(), validPayload());
    const user = await validateAuth(
      ctx({
        'Cf-Access-Jwt-Assertion': token,
        'X-Auth-User': 'intruder@example.com',
        'Cf-Access-Authenticated-User-Email': 'intruder@example.com',
      }),
      jwtConfig
    );
    expect(user).toBe('alex');
  });

  it('fails closed when JWT config is missing', async () => {
    const token = signToken(validHeader(), validPayload());
    const user = await validateAuth(
      ctx({
        'Cf-Access-Jwt-Assertion': token,
        'X-Auth-User': EMAIL,
      }),
      { mode: 'header', headerName: 'X-Auth-User' }
    );
    expect(user).toBeNull();
  });

  it('throws in production when JWT config is missing', () => {
    expect(() =>
      assertProductionAuthConfig({ mode: 'header' }, 'production')
    ).toThrow(/CF_ACCESS_TEAM_DOMAIN/);
    expect(() =>
      assertProductionAuthConfig(jwtConfig, 'production')
    ).not.toThrow();
  });
});

describe('Cloudflare Access URLs', () => {
  it('builds the team JWKS URL from CF_ACCESS_TEAM_DOMAIN', () => {
    expect(accessHost('example.cloudflareaccess.com')).toBe('example.cloudflareaccess.com');
    expect(cloudflareAccessJwksUrl('example.cloudflareaccess.com')).toBe(
      'https://example.cloudflareaccess.com/cdn-cgi/access/certs'
    );
    expect(cloudflareAccessJwksUrl('myteam')).toBe(
      'https://myteam.cloudflareaccess.com/cdn-cgi/access/certs'
    );
  });
});
