// The Next.js adapter. The whole of a property's callback route is:
//
//   export { GET } from "sandbox-auth/next";
//
// and where it needs the member:  const member = await getSession();
import { NextResponse } from 'next/server';
import { cookies as nextCookies } from 'next/headers';
import {
  resolveConfig, completeSignIn, readSession, revoked, endSessionUrl, cookieName, sessionToken, memberPass,
} from './core.mjs';

function cfgOnce(overrides) {
  return resolveConfig(overrides);
}

function originOf(request) {
  const h = request.headers;
  const proto = h.get('x-forwarded-proto') || 'https';
  const host = h.get('x-forwarded-host') || h.get('host');
  return `${proto}://${host}`;
}

// The one-line callback route mounts this. The config is read on the first
// request, not when the route file is imported, so a build that imports it
// before the app has a client id still succeeds.
export function callback(overrides = {}) {
  let cfg;
  return async function GET(request) {
    cfg ??= cfgOnce(overrides);
    const origin = originOf(request);
    const secure = origin.startsWith('https://');
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const cookies = Object.fromEntries((request.cookies.getAll?.() ?? []).map((c) => [c.name, c.value]));
    const result = await completeSignIn({ cfg, query, cookies, redirectUri: `${origin}${cfg.callbackPath}` });

    // Back to the sign-in page, saying why, so the app can tell the member and
    // the builder can tell what broke. access_denied is the member choosing
    // Cancel on auth's consent screen; the rest are listed in the README.
    if (result.error) {
      const retry = new URL(overrides.retryPath || '/login', origin);
      retry.searchParams.set('error', result.error);
      const res = NextResponse.redirect(retry);
      res.cookies.delete(cfg.txCookie);
      return res;
    }
    const res = NextResponse.redirect(new URL(result.next, origin));
    res.cookies.set(cookieName(cfg, secure), result.token, {
      httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: cfg.sessionTtl,
    });
    res.cookies.delete(cfg.txCookie);
    return res;
  };
}

// Default handler, resolved lazily on first request so importing this module —
// which Next does at build time — never needs the env to be present yet.
let defaultHandler;
export async function GET(request) {
  if (!defaultHandler) defaultHandler = callback();
  return defaultHandler(request);
}

// Read the member in a server component / route / middleware.
//
// Cookies first, config second. Reading cookies is what tells Next the page
// is dynamic, so a build never pre-renders it — and someone with no session
// is simply nobody, whatever is configured. Together those let a first deploy
// build and run before the app has its client id.
export async function getSession(overrides = {}) {
  const token = sessionToken(await nextCookies(), overrides);
  if (!token) return null;
  const cfg = cfgOnce(overrides);
  const session = await readSession(cfg, token);
  // A session the member has since signed out of Sandbox is no session here.
  if (session && await revoked(cfg, session)) return null;
  return session;
}

/**
 * The member pass, for calling the directory as this member: a current one,
 * or null when nobody is signed in or there is none to be had.
 *
 * In a route handler or server action, an expired pass is renewed and the
 * session cookie updated. In a server component cookies can't be written, so
 * it is not renewed there — the proxy in the README keeps it fresh on every
 * request instead.
 */
export async function getMemberPass(overrides = {}) {
  const store = await nextCookies();
  const token = sessionToken(store, overrides);
  if (!token) return null;
  const cfg = cfgOnce(overrides);
  const current = await memberPass(cfg, token);
  if (current.pass) return current.pass;

  const secure = Boolean(store.get(cookieName(cfg, true)));
  const name = cookieName(cfg, secure);
  const options = { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: cfg.sessionTtl };
  // Renewing uses up the refresh token, so only where the new one can be kept.
  try {
    store.set(name, token, options);
  } catch {
    return null;
  }
  const renewed = await memberPass(cfg, token, { renew: true });
  if (!renewed.token) return null;
  store.set(name, renewed.token, options);
  return renewed.pass;
}

export function signOutUrl(overrides = {}, postLogout) {
  return endSessionUrl(cfgOnce(overrides), postLogout);
}

// Clears the property's session cookie on the given response and returns the
// auth sign-out URL to offer.
export function signOut(response, overrides = {}, postLogout) {
  const cfg = cfgOnce(overrides);
  for (const secure of [true, false]) {
    response.cookies.set(cookieName(cfg, secure), '', { path: '/', maxAge: 0, httpOnly: true, secure, sameSite: 'lax' });
  }
  return endSessionUrl(cfg, postLogout);
}
