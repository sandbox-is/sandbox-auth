// sandbox-auth — the drop-in a property uses to consume auth.sandbox.is.
//
// A property authenticates the person, not itself: it is a public client, so
// there is no secret here. What it does need is on its own origin — receive the
// redirect the button sent, and set its own session cookie. This core is the
// logic of that, with no framework in it; the node and next adapters are a
// dozen lines each on top.
import { SignJWT, jwtVerify, createRemoteJWKSet, decodeJwt } from 'jose';

const DEFAULT_AUTH = 'https://auth.sandbox.is';
const CALLBACK_PATH = '/api/auth/callback';
const TX_COOKIE = 'sbx_auth';                 // the button sets this on the property's origin
const DEFAULT_SESSION_TTL = 30 * 24 * 60 * 60;
const DEFAULT_COOKIE = 'sandbox_session';

const jwks = new Map();
function keysFor(authOrigin, headers) {
  const key = authOrigin + (headers ? ':bypass' : '');
  if (!jwks.has(key)) jwks.set(key, createRemoteJWKSet(new URL(`${authOrigin}/jwks`), headers ? { headers } : undefined));
  return jwks.get(key);
}

export function resolveConfig(o = {}) {
  const authOrigin = (o.authOrigin ?? process.env.SANDBOX_AUTH_ORIGIN ?? DEFAULT_AUTH).replace(/\/$/, '');
  // The property is a client of Sandbox Auth, so both are SANDBOX_AUTH_CLIENT_*:
  // the id it is known by, and the secret that signs its own session cookie
  // (which auth never sees). Fixed names — within a property's own environment
  // there is only ever one client, so they are unambiguous.
  const clientId = o.clientId ?? process.env.SANDBOX_AUTH_CLIENT_ID;
  if (!clientId) throw new Error('sandbox-auth: set SANDBOX_AUTH_CLIENT_ID (or pass clientId)');
  const sessionSecret = o.sessionSecret ?? process.env.SANDBOX_AUTH_CLIENT_SESSION_SECRET;
  if (!sessionSecret) throw new Error('sandbox-auth: set SANDBOX_AUTH_CLIENT_SESSION_SECRET (or pass sessionSecret)');
  return {
    authOrigin,
    clientId,
    sessionSecret,
    cookieBase: o.cookieName ?? DEFAULT_COOKIE,
    sessionTtl: o.sessionTtl ?? (process.env.SANDBOX_AUTH_CLIENT_SESSION_TTL ? Number(process.env.SANDBOX_AUTH_CLIENT_SESSION_TTL) : DEFAULT_SESSION_TTL),
    callbackPath: o.callbackPath ?? CALLBACK_PATH,
    txCookie: TX_COOKIE,
    // Only for reaching a protection-gated preview auth in testing; a property
    // talking to production auth never sets this.
    bypass: o.bypass ?? process.env.SANDBOX_AUTH_BYPASS,
  };
}

// __Host- is host-only and needs Secure and a root path, which https gives; a
// plain http dev server cannot set it, so the name falls back there.
export function cookieName(cfg, secure) {
  return secure ? `__Host-${cfg.cookieBase}` : cfg.cookieBase;
}

// The session cookie's value, from anything with a get(name) that answers a
// string or { value } — Next's request and header cookies, a Map, a plain
// lookup. Needs no config: someone without the cookie is nobody, and saying
// so does not wait for the app to have its client id.
export function sessionToken(cookies, overrides = {}) {
  const base = { cookieBase: overrides.cookieName ?? DEFAULT_COOKIE };
  const read = (name) => {
    const found = cookies.get(name);
    return typeof found === 'string' ? found : found?.value;
  };
  return read(cookieName(base, true)) ?? read(cookieName(base, false)) ?? null;
}

const secretBytes = (cfg) => new TextEncoder().encode(cfg.sessionSecret);
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

// The callback, as pure data in and out: the button's cookie and the query
// become either a session token (and where to go next) or an error.
export async function completeSignIn({ cfg, query, cookies, redirectUri }) {
  let tx;
  try { tx = JSON.parse(decodeURIComponent(cookies[cfg.txCookie] || '')); } catch { tx = null; }
  if (!tx || !tx.verifier) return { error: 'no_transaction' };
  if (query.error) return { error: String(query.error) };
  if (query.state !== tx.state) return { error: 'state_mismatch' };
  if (!query.code) return { error: 'no_code' };

  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cfg.bypass) headers['x-vercel-protection-bypass'] = cfg.bypass;
  const res = await fetch(`${cfg.authOrigin}/token`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      code: query.code,
      redirect_uri: redirectUri,
      code_verifier: tx.verifier,
    }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.id_token) return { error: body.error || 'exchange_failed' };

  let claims;
  try {
    ({ payload: claims } = await jwtVerify(
      body.id_token,
      keysFor(cfg.authOrigin, cfg.bypass ? { 'x-vercel-protection-bypass': cfg.bypass } : null),
      { issuer: cfg.authOrigin, audience: cfg.clientId },
    ));
  } catch {
    return { error: 'token_invalid' };
  }
  if (claims.nonce !== tx.nonce) return { error: 'nonce_mismatch' };

  const member = withOptional({ sub: String(claims.sub), name: claims.name, email: claims.email }, claims);
  const now = Math.floor(Date.now() / 1000);
  const token = await signSession(cfg, member, passFrom(body), { iat: now, exp: now + cfg.sessionTtl });

  return { member, token, next: safeNext(tx.next) };
}

// The member pass and what renews it, from a token response: an access token
// for the directory, when it lasts until, and the refresh token. Kept in the
// app's own session cookie, out of sight of anything but the app's server.
function passFrom(body) {
  if (!body.access_token) return {};
  let exp;
  try { ({ exp } = decodeJwt(body.access_token)); } catch { return {}; }
  return { pass: body.access_token, pass_exp: exp, ...(body.refresh_token ? { rt: body.refresh_token } : {}) };
}

function signSession(cfg, member, pass, { iat, exp }) {
  const { sub, ...profile } = member;
  return new SignJWT({ ...profile, ...pass })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretBytes(cfg));
}

/**
 * The member pass behind a session: an access token for the directory, which
 * an app sends there to act for this member (the directory's Lookup). Good
 * for an hour. When it has run out — or has under a minute left — and
 * `renew` is set, it is renewed with the refresh token kept in the session,
 * and a new session token comes back to replace the old cookie.
 *
 * Renew only where that new cookie can be kept: the refresh token is used up
 * by renewing, and a session that kept the old one could not renew again.
 * The new session keeps the old one's issue time and expiry, so a Sandbox
 * sign-out still ends it.
 *
 * Returns { pass } (null when there is none to give) and, after renewing,
 * { token }.
 */
export async function memberPass(cfg, token, { renew = false } = {}) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token ?? '', secretBytes(cfg)));
  } catch {
    return { pass: null };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.pass && payload.pass_exp - now > 60) return { pass: payload.pass };
  if (!renew || !payload.rt) return { pass: null };

  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cfg.bypass) headers['x-vercel-protection-bypass'] = cfg.bypass;
  const res = await fetch(`${cfg.authOrigin}/token`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.clientId, refresh_token: payload.rt })
      .toString(),
  }).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  const pass = passFrom(body);
  if (!pass.pass) return { pass: null };

  const member = withOptional({ sub: String(payload.sub), name: payload.name, email: payload.email }, payload);
  return { pass: pass.pass, token: await signSession(cfg, member, pass, { iat: payload.iat, exp: payload.exp }) };
}

/**
 * For a proxy or middleware: a renewed session token when the pass in this
 * one has run out or nearly has, or null when nothing needs doing. Setting it
 * on the request and the response keeps the pass fresh for every page.
 */
export async function renewSession(cfg, token) {
  const current = await memberPass(cfg, token);
  if (current.pass) return null;
  const renewed = await memberPass(cfg, token, { renew: true });
  return renewed.token ?? null;
}

// What auth sends only when there is something to send, copied through as is
// and left out otherwise — never null. The photo URL and phone number go to
// every property; member_data only to an app a member built, holding the
// profile fields the member agreed to share with it.
const OPTIONAL = ['picture', 'phone_number', 'member_data'];

function withOptional(member, claims) {
  for (const key of OPTIONAL) {
    if (claims[key] != null) member[key] = claims[key];
  }
  return member;
}

// The verified member behind a session token, or null. Identity only — a
// property reads its own roles from its own records, never from here.
export async function readSession(cfg, token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretBytes(cfg));
    return withOptional(
      { sub: String(payload.sub), name: payload.name, email: payload.email, iat: payload.iat },
      payload,
    );
  } catch {
    return null;
  }
}

// Whether a Sandbox sign-out (or an admin revocation) has invalidated this
// session. Auth records the moment a member's sessions were ended; any property
// session issued before it is dead, while a fresh login after it — with a newer
// issued-at — survives. The check is a fetch of a short-lived, CDN-cached
// endpoint on auth, so it is edge-cheap and rarely reaches auth itself. It does
// not make a property depend on auth being up: any error or timeout fails open,
// leaving the session's own expiry as the backstop. Global effect lands within
// the cache window (~15s).
export async function revoked(cfg, session) {
  if (!session?.sub || !session?.iat) return false;
  let res;
  try {
    res = await fetch(`${cfg.authOrigin}/revocations/${encodeURIComponent(session.sub)}`, {
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    return false; // auth unreachable — fail open rather than lock the property
  }
  if (!res.ok) return false;
  const body = await res.json().catch(() => null);
  const signedOutAt = body && typeof body.signedOutAt === 'number' ? body.signedOutAt : null;
  return signedOutAt != null && signedOutAt > session.iat;
}

export function endSessionUrl(cfg, postLogout) {
  const url = new URL(`${cfg.authOrigin}/session/end`);
  if (postLogout) url.searchParams.set('post_logout_redirect_uri', postLogout);
  return url.href;
}
