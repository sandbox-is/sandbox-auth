// The Node http adapter. A property with a plain server wires three methods and
// is done.
import { resolveConfig, completeSignIn, readSession, revoked, endSessionUrl, cookieName, memberPass } from './core.mjs';

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The reason is for whoever builds the app; the member is told only what they
// need, and that their account is fine.
const ERROR_PAGE = (retry, reason) => `<!doctype html><meta charset="utf-8">
<title>Sign-in could not be completed</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;color:#111;background:#fafafa;display:flex;min-height:100dvh;align-items:center;justify-content:center;margin:0}main{max-width:26rem;text-align:center;padding:2rem}a{color:#211AFF}</style>
<main><h1 style="font-size:1.1rem">Sign-in could not be completed</h1>
<p style="color:#6b7280">Nothing is wrong with your account. <a href="${retry}">Try again</a>.</p>
<p style="color:#9ca3af;font-size:12px">${escapeHtml(reason)}</p></main>`;

export function sandboxAuth(overrides = {}) {
  const cfg = resolveConfig(overrides);

  function clearTx(secure) {
    return `${cfg.txCookie}=; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
  }

  return {
    cfg,

    // Mount at the callback path you registered with auth.
    async handleCallback(req, res) {
      const origin = originOf(req);
      const secure = origin.startsWith('https://');
      const query = Object.fromEntries(new URL(req.url, origin).searchParams);
      const result = await completeSignIn({
        cfg,
        query,
        cookies: parseCookies(req),
        redirectUri: `${origin}${cfg.callbackPath}`,
      });

      if (result.error) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('set-cookie', clearTx(secure));
        res.end(ERROR_PAGE(overrides.retryPath || '/', result.error));
        return;
      }

      res.statusCode = 302;
      res.setHeader('set-cookie', [
        `${cookieName(cfg, secure)}=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.sessionTtl}${secure ? '; Secure' : ''}`,
        clearTx(secure),
      ]);
      res.setHeader('location', result.next);
      res.end();
    },

    // The verified member, or null.
    async getSession(req) {
      const cookies = parseCookies(req);
      const session = await readSession(cfg, cookies[cookieName(cfg, true)] ?? cookies[cookieName(cfg, false)]);
      // A session the member has since signed out of Sandbox is no session here.
      if (session && await revoked(cfg, session)) return null;
      return session;
    },

    // The member pass, for calling the directory as this member, renewed
    // when it has run out — the session cookie is updated on `res`.
    async getMemberPass(req, res) {
      const cookies = parseCookies(req);
      const secure = Boolean(cookies[cookieName(cfg, true)]);
      const token = cookies[cookieName(cfg, secure)];
      if (!token) return null;
      const renewed = await memberPass(cfg, token, { renew: true });
      if (renewed.token) {
        res.appendHeader('set-cookie',
          `${cookieName(cfg, secure)}=${renewed.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.sessionTtl}${secure ? '; Secure' : ''}`);
      }
      return renewed.pass;
    },

    // Ends the local session; returns the auth sign-out URL to offer.
    signOut(req, res) {
      const origin = originOf(req);
      res.setHeader('set-cookie', [
        `${cookieName(cfg, true)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
        `${cookieName(cfg, false)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      ]);
      return endSessionUrl(cfg, `${origin}/`);
    },
  };
}
