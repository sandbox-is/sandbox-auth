// The page check for a Next.js app, whole: the file is
//
//   import { sandboxProxy } from "sandbox-auth/proxy";
//   export default (request) => sandboxProxy(request);
//   export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
//
// It lets public paths through, sends anyone without a session (or with one
// from before a Sandbox sign-out) to the login page, keeps the member pass
// fresh, and gives a session that can't renew its pass one trip through auth
// to pick up a refresh token. Kept apart from sandbox-auth/next, which reads
// next/headers — something a proxy can't do.
import { NextResponse } from 'next/server';
import {
  resolveConfig, readSession, revoked, sessionToken, renewSession, cookieName,
  needsPassUpgrade, startSignIn, UPGRADE_COOKIE,
} from './core.mjs';

// A page someone is opening, as opposed to an API call, a React Server
// Components request or a prefetch: the only kind worth sending anywhere.
function isPageLoad(request) {
  const h = request.headers;
  if (request.method !== 'GET') return false;
  if (!(h.get('accept') ?? '').includes('text/html')) return false;
  if (h.get('rsc') || h.get('next-router-prefetch') || h.get('next-router-state-tree')) return false;
  if (/prefetch/i.test(h.get('sec-purpose') ?? '') || /prefetch/i.test(h.get('purpose') ?? '')) return false;
  const dest = h.get('sec-fetch-dest');
  return !dest || dest === 'document';
}

export async function sandboxProxy(request, { publicPaths = ['/login', '/api/auth'], loginPath = '/login', ...overrides } = {}) {
  const { pathname, search } = request.nextUrl;
  if (publicPaths.some((p) => pathname.startsWith(p))) return NextResponse.next();

  // The cookie first: without one there's nothing to check, and this works
  // before the app has its client id.
  const token = sessionToken(request.cookies, overrides);
  let cfg;
  let signedIn = false;
  if (token) {
    cfg = resolveConfig(overrides);
    const session = await readSession(cfg, token);
    signedIn = session !== null && !(await revoked(cfg, session));
  }
  if (!signedIn) {
    const login = new URL(loginPath, request.url);
    login.searchParams.set('next', pathname + search);
    return NextResponse.redirect(login);
  }

  const secure = request.nextUrl.protocol === 'https:';

  // Signed in before the member pass could renew: once, on a page load, a
  // quick trip through auth to pick up a refresh token.
  if (isPageLoad(request) && !request.cookies.get(UPGRADE_COOKIE) && await needsPassUpgrade(cfg, token)) {
    const { url, tx } = await startSignIn(cfg, { origin: request.nextUrl.origin, next: pathname + search });
    const response = NextResponse.redirect(url);
    response.cookies.set(cfg.txCookie, tx, { path: '/', maxAge: 600, sameSite: 'lax', secure, httpOnly: true });
    response.cookies.set(UPGRADE_COOKIE, '1', { path: '/', maxAge: cfg.sessionTtl, sameSite: 'lax', secure, httpOnly: true });
    return response;
  }

  // Keep the member pass fresh for this request's pages (getMemberPass).
  const renewed = await renewSession(cfg, token);
  if (renewed) {
    const name = cookieName(cfg, secure);
    request.cookies.set(name, renewed);
    const response = NextResponse.next({ request: { headers: request.headers } });
    response.cookies.set(name, renewed, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: cfg.sessionTtl });
    return response;
  }
  return NextResponse.next();
}
