import { fetch as expoFetch } from 'expo/fetch';

import { createPkcePair } from '@/lib/hermes/pkce';
import { HermesError, parseHermesErrorBody } from '@/lib/hermes/errors';
import type { AuthProvider, TokenReply } from '@/lib/hermes/wire';
import type { StoredAuth } from '@/lib/hermes/tokens';
import { getServerBase } from '@/lib/opencode/client/url';

export const HERMES_CALLBACK_URL = 'http://127.0.0.1:47821/callback';
const PKCE_COOKIE_NAME = 'hermes_session_pkce';

export type SignInCredentials = { serverUrl: string; username: string; password: string };

export function hermesBaseUrl(serverUrl: string): string {
  return getServerBase(serverUrl).displayUrl;
}

async function readErrorMessage(response: Response): Promise<HermesError> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = undefined;
  }
  return parseHermesErrorBody(body, response.status);
}

// Step 0 of the MyHermit sign-in: confirm the dashboard offers a password
// provider and return its name. Doubles as the reachability probe.
export async function discoverPasswordProvider(baseUrl: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/providers`, { signal });
  if (!response.ok) throw await readErrorMessage(response);
  let payload: { providers?: AuthProvider[] };
  try {
    payload = await response.json();
  } catch {
    throw new HermesError('The server sent a reply the app did not understand.', response.status);
  }
  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  const provider = providers.find((entry) => entry.supportsPassword === true || entry.supports_password === true);
  if (!provider) {
    throw new HermesError('This Hermes dashboard has no username/password sign-in. Add dashboard.basic_auth to the server config first.', response.status);
  }
  return provider.name;
}

function readSetCookie(response: Response): string | undefined {
  // Web fetch never exposes Set-Cookie; native fetch may. When it is missing we
  // rely on the platform cookie jar via credentials: 'include'.
  const value = response.headers.get('set-cookie');
  if (!value) return undefined;
  const match = value.match(new RegExp(`${PKCE_COOKIE_NAME}=([^;]+)`));
  return match ? `${PKCE_COOKIE_NAME}=${match[1]}` : undefined;
}

type AuthorizeResult = { cookie?: string };

// Step 1: start the PKCE flow. The server answers with a 302 to /login plus a
// `hermes_session_pkce` cookie that must ride along on the password-login call.
// RN's XHR cannot stop redirects, so we follow them and rely on the platform
// cookie jar (browsers and iOS both keep it; the request itself just needs
// credentials: 'include'). When expo/fetch gives us a manual redirect response
// we capture the cookie header explicitly instead.
async function authorize(baseUrl: string, provider: string, challenge: string, state: string, signal?: AbortSignal): Promise<AuthorizeResult> {
  const url = `${baseUrl}/auth/native/authorize?provider=${encodeURIComponent(provider)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(HERMES_CALLBACK_URL)}&state=${encodeURIComponent(state)}`;
  try {
    const response = await expoFetch(url, { redirect: 'manual', credentials: 'include' });
    const cookie = readSetCookie(response as unknown as Response);
    const responseType = (response as unknown as { type?: string }).type;
    if (!response.ok && responseType !== 'opaqueredirect' && response.status !== 0 && response.status >= 400) {
      throw await readErrorMessage(response as unknown as Response);
    }
    if (cookie) return { cookie };
    // A followed redirect means the native jar already holds the cookie.
    return {};
  } catch (error) {
    if (error instanceof HermesError) throw error;
    // expo/fetch refused the mode or the platform lacks it; fall back to the
    // shared cookie jar with a followed redirect.
    const response = await fetch(url, { credentials: 'include', signal });
    if (!response.ok) throw await readErrorMessage(response);
    return { cookie: readSetCookie(response) };
  }
}

// Steps 2–3: password login against the PKCE cookie, then redeem the code.
export async function signInWithPassword(credentials: SignInCredentials, signal?: AbortSignal): Promise<StoredAuth> {
  const baseUrl = hermesBaseUrl(credentials.serverUrl);
  const provider = await discoverPasswordProvider(baseUrl, signal);
  const { verifier, challenge } = await createPkcePair();
  const state = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  const authorizeResult = await authorize(baseUrl, provider, challenge, state, signal);

  const loginResponse = await fetch(`${baseUrl}/auth/password-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorizeResult.cookie ? { Cookie: authorizeResult.cookie } : {}),
    },
    credentials: 'include',
    body: JSON.stringify({ provider, username: credentials.username, password: credentials.password, next: '' }),
    signal,
  });
  if (!loginResponse.ok) {
    const error = await readErrorMessage(loginResponse);
    if (loginResponse.status === 401) throw new HermesError('Wrong username or password.', 401);
    if (loginResponse.status === 400 && /cookie/i.test(error.message)) {
      throw new HermesError('The server did not start the native sign-in (no sign-in cookie).', 400);
    }
    throw error;
  }
  let nextUrl: string;
  try {
    nextUrl = ((await loginResponse.json()) as { next?: string }).next ?? '';
  } catch {
    throw new HermesError('The server sent a reply the app did not understand.', loginResponse.status);
  }
  let code: string | null = null;
  let returnedState: string | null = null;
  try {
    const parsed = new URL(nextUrl);
    code = parsed.searchParams.get('code');
    returnedState = parsed.searchParams.get('state');
  } catch {
    // Falls through to the guard below.
  }
  if (!code || returnedState !== state) {
    throw new HermesError('The server did not complete the native sign-in.', loginResponse.status);
  }

  const tokenReply = await redeemToken(baseUrl, code, verifier, signal);
  return {
    server: baseUrl,
    username: credentials.username,
    provider: tokenReply.provider ?? provider,
    accessToken: tokenReply.access_token,
    refreshToken: tokenReply.refresh_token,
    expiresAt: tokenReply.expires_at,
  };
}

export async function redeemToken(baseUrl: string, code: string, verifier: string, signal?: AbortSignal): Promise<TokenReply> {
  const response = await fetch(`${baseUrl}/auth/native/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier }),
    signal,
  });
  if (!response.ok) throw await readErrorMessage(response);
  const reply = (await response.json()) as TokenReply;
  if (!reply.access_token || !reply.refresh_token) {
    throw new HermesError('The server sent a reply the app did not understand.', response.status);
  }
  return reply;
}

export async function refreshAccessToken(baseUrl: string, refreshToken: string, provider: string, signal?: AbortSignal): Promise<TokenReply> {
  const response = await fetch(`${baseUrl}/auth/native/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken, provider }),
    signal,
  });
  if (!response.ok) throw await readErrorMessage(response);
  const reply = (await response.json()) as TokenReply;
  if (!reply.access_token || !reply.refresh_token) {
    throw new HermesError('The server sent a reply the app did not understand.', response.status);
  }
  return reply;
}
