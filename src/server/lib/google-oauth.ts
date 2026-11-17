export interface GoogleProfile {
  email: string;
  sub: string;
  name?: string;
}

export async function exchangeGoogleCode(
  code: string,
  options: { clientId: string; clientSecret: string; redirectUri: string }
): Promise<GoogleProfile> {
  const body = new URLSearchParams({
    code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    grant_type: 'authorization_code',
  });
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!tokenRes.ok) {
    throw new Error("Google didn't share an email");
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new Error("Google didn't share an email");
  }
  const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!userRes.ok) {
    throw new Error("Google didn't share an email");
  }
  const profile = (await userRes.json()) as { email?: string; sub?: string; name?: string };
  if (!profile.email || !profile.sub) {
    throw new Error("Google didn't share an email");
  }
  return { email: profile.email, sub: profile.sub, name: profile.name };
}

export function googleAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: options.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
