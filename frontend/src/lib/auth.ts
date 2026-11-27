const authUrl = (import.meta.env.PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? '';
const sessionKey = 'lanoche.auth.session';
const verifierKey = 'lanoche.auth.pkce_verifier';
const returnKey = 'lanoche.auth.return_to';
let authGeneration = 0;
let refreshInFlight: Promise<AuthSession | null> | undefined;

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
}

function ensureAuthConfig() {
  if (!authUrl || !anonKey) throw new Error('Falta configurar el acceso seguro de la gala.');
}

function toBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeReturnPath(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/app';
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/app';
  } catch { return '/app'; }
}

export async function startGoogleSignIn(returnTo = '/app') {
  ensureAuthConfig();
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const callback = new URL('/auth/callback', window.location.origin);
  const destination = safeReturnPath(returnTo);
  sessionStorage.setItem(verifierKey, verifier);
  sessionStorage.setItem(returnKey, destination);
  const authorize = new URL(`${authUrl}/auth/v1/authorize`);
  authorize.searchParams.set('provider', 'google');
  authorize.searchParams.set('redirect_to', callback.toString());
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 's256');
  window.location.assign(authorize.toString());
}

export function getSession(): AuthSession | null {
  const raw = sessionStorage.getItem(sessionKey);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as AuthSession;
    if (session.expires_at <= Date.now() / 1000) return null;
    return session;
  } catch {
    sessionStorage.removeItem(sessionKey);
    return null;
  }
}

export async function getValidSession(): Promise<AuthSession | null> {
	const session = getSession();
	if (session) return session;
	if (refreshInFlight) return refreshInFlight;
	const raw = sessionStorage.getItem(sessionKey);
	if (!raw) return null;
	const generation = authGeneration;
	refreshInFlight = (async () => {
	try {
		const expired = JSON.parse(raw) as AuthSession;
		if (!expired.refresh_token || !authUrl || !anonKey) {
			sessionStorage.removeItem(sessionKey);
			return null;
		}
		const response = await fetch(`${authUrl}/auth/v1/token?grant_type=refresh_token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', apikey: anonKey },
			body: JSON.stringify({ refresh_token: expired.refresh_token }),
		});
		const body = await response.json().catch(() => null);
		if (!response.ok || !body?.access_token) {
			if (generation === authGeneration && sessionStorage.getItem(sessionKey) === raw) sessionStorage.removeItem(sessionKey);
			return null;
		}
		const refreshed: AuthSession = {
			access_token: body.access_token,
			refresh_token: body.refresh_token,
			expires_at: Math.floor(Date.now() / 1000) + Number(body.expires_in ?? 3600),
			token_type: body.token_type ?? 'bearer',
		};
		if (generation !== authGeneration) return null;
		saveSession(refreshed);
		return refreshed;
	} catch {
		// Keep the stored refresh token during network outages. The caller can
		// still try the API and show a recoverable connectivity error.
		try { return JSON.parse(raw) as AuthSession; }
		catch { sessionStorage.removeItem(sessionKey); return null; }
	}
	})().finally(() => { refreshInFlight = undefined; });
	return refreshInFlight;
}

export function saveSession(session: AuthSession) {
  sessionStorage.setItem(sessionKey, JSON.stringify(session));
}

export function clearSession() {
  authGeneration++;
  sessionStorage.removeItem(sessionKey);
}

export async function finishOAuthCallback(search: string): Promise<string> {
  ensureAuthConfig();
  const params = new URLSearchParams(search);
  const code = params.get('code');
  if (!code) {
    sessionStorage.removeItem(verifierKey);
    sessionStorage.removeItem(returnKey);
    throw new Error(params.get('error_description') ?? params.get('error') ?? 'Google canceló el acceso.');
  }
  const verifier = sessionStorage.getItem(verifierKey);
  if (!verifier) throw new Error('La sesión de acceso expiró. Vuelve a intentarlo.');

  const response = await fetch(`${authUrl}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    sessionStorage.removeItem(verifierKey);
    sessionStorage.removeItem(returnKey);
    throw new Error(body?.msg ?? body?.message ?? 'No se pudo completar el acceso con Google.');
  }
  saveSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(body.expires_in ?? 3600),
    token_type: body.token_type ?? 'bearer',
  });
  sessionStorage.removeItem(verifierKey);
  const destination = safeReturnPath(sessionStorage.getItem(returnKey));
  sessionStorage.removeItem(returnKey);
  return destination;
}
