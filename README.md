# sandbox-auth

sandbox-auth lets your web app sign people in with their Sandbox account, through **[auth.sandbox.is](https://auth.sandbox.is)**.

When someone signs in, you find out who they are: their Sandbox member id, name, email, and their phone number and photo if they have them. An app a member built also gets `member_data`: the profile fields it asked for that the member agreed to share. What they're allowed to do is up to you — keep roles in your own database and look them up by the member id. Sandbox handles identity; your app handles permissions.

Each app gets its own session, tied to its own domain, so one Sandbox site can't read another's.

There are two adapters, plus a framework-free core to build on for anything else:

- **Next.js** (App Router) → `sandbox-auth/next`
- **Node** (plain `http` server) → `sandbox-auth/node`
- **anything else** → `sandbox-auth/core`

The examples below cover Next.js and Node. Setting it up is four small steps, after [linking your app](#0-link-your-app):

1. [the button](#1-the-button) on your login page
2. [one callback route](#2-the-callback)
3. [configuration](#3-configuration)
4. [reading who's signed in](#read-whos-signed-in) — plus a [middleware check](#gate-pages) if you protect pages

---

## 0. Link your app

Sign in with Sandbox is for Sandbox members. To use it in an app you build:

1. **Deploy it first.** Linking needs your app's live https address. That first deploy can go out without a client id: it builds, protected pages send people to your login page, and the login page shows no button yet. You can set `SANDBOX_AUTH_CLIENT_SESSION_SECRET` straight away; only the client id waits for approval.
2. **Link it** on the Developers page at [members.sandbox.is/developers](https://members.sandbox.is/developers) (you sign in with Sandbox). Give its address, a local port for development if you want one, and any [profile fields](#profile-fields) you'd like to ask for.
3. **Wait for an admin to approve it.** The Developers page then shows your client id.
4. **Add the id** to your app's environment ([configuration](#3-configuration)), including for its build step, and deploy again.

What auth accepts as your app's address:

- A bare https address with no path, like `https://polls.example.com`. It can't be changed later; a new address means linking again.
- Not `localhost`: for local development, give a port instead.
- A subdomain of `sandbox.is` is fine, but not one Sandbox itself uses, like `auth.sandbox.is` or `members.sandbox.is`, nor the bare `sandbox.is`.
- Auth then sends people back to exactly `https://<your address>/api/auth/callback`, and `http://localhost:<port>/api/auth/callback` if you gave a port.
- If your app already uses `/api/auth/` for something else (NextAuth does), register a different callback path when you link it, like `/auth/sandbox/callback`. It has to be a plain path: letters, digits, `- _ . ~` and `/`. Then set it in [your callback route](#2-the-callback) and on [the button](#1-the-button) too.

The first time each person signs in, auth shows them what your app will get: their name, email, phone and photo, plus a switch for each profile field you asked for. Those switches start on, and they can turn any of them off. Their answer is remembered until they choose Stop sharing on their Sandbox account page at auth.sandbox.is. If you later ask for a new field, they're asked about it once.

---

## Install

Install it from GitHub, pinned to a version tag. It isn't published to npm.

```json
{
  "dependencies": {
    "sandbox-auth": "git+https://github.com/sandbox-is/sandbox-auth.git#v0.7.2",
    "jose": "^5"
  }
}
```

`jose` does the signing and checking of the session token. Install it alongside if your app doesn't already use it.

---

## 1. The button

The button comes from auth: a snippet of HTML and a script tag that work on any page. The script sets up the sign-in and sends the person to auth to log in. Add it to your login page:

```html
<div data-sandbox-signin data-client="your-client-id"></div>
<script src="https://auth.sandbox.is/button.js"></script>
```

To send them to a particular page after they sign in, add `data-next`:

```html
<div data-sandbox-signin data-client="your-client-id" data-next="/dashboard"></div>
```

| attribute | | |
|---|---|---|
| `data-client` | **required** | your registered client id |
| `data-next` | optional | where to land after signing in |
| `data-callback` | only with a custom path | the full URL of your callback, e.g. `https://polls.example.com/auth/sandbox/callback`; defaults to your origin plus `/api/auth/callback` |
| `data-scope` | leave unset | defaults to `openid`, the only scope there is |

If the button doesn't appear, the client id isn't one auth knows. See [troubleshooting](#troubleshooting).

In a Next.js app, use the same two tags and load the script with `next/script`. This version also sends people back to the page they were trying to reach, which the [page check](#gate-pages) passes as `?next=`, and shows why a sign-in failed, which the callback passes as `?error=`:

```tsx
// app/login/page.tsx
import Script from "next/script";

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <>
      {error === "access_denied" && <p>You chose not to share your details, so you're not signed in.</p>}
      {error && error !== "access_denied" && <p>Signing in didn't work. Try again.</p>}
      <div data-sandbox-signin data-client={process.env.SANDBOX_AUTH_CLIENT_ID} data-next={next ?? "/dashboard"} />
      <Script src="https://auth.sandbox.is/button.js" strategy="afterInteractive" />
    </>
  );
}
```

## 2. The callback

You add one route. It handles the person coming back from auth: it checks them and sets your app's session cookie.

**Next.js** — the whole route file, `app/api/auth/callback/route.ts`:

```ts
export { GET } from "sandbox-auth/next";
```

**Node** — one method on your server:

```js
import { sandboxAuth } from "sandbox-auth/node";
const sandbox = sandboxAuth();

// in your request handler:
if (path === "/api/auth/callback") return sandbox.handleCallback(req, res);
```

Put it at `/api/auth/callback`, the path auth sends people back to unless you registered another.

**A different path.** If you registered one, put the route there and tell the library, so the address it sends to auth matches:

```ts
// app/auth/sandbox/callback/route.ts
import { callback } from "sandbox-auth/next";
export const GET = callback({ callbackPath: "/auth/sandbox/callback" });
```

```js
// Node
const sandbox = sandboxAuth({ callbackPath: "/auth/sandbox/callback" });
if (path === "/auth/sandbox/callback") return sandbox.handleCallback(req, res);
```

And give the button the full URL with `data-callback`.

When a sign-in can't be completed, the Next.js route sends the person to `/login?error=<reason>` (change the page with `retryPath`), and the Node adapter shows a short page with the reason in small print. The reasons are listed under [troubleshooting](#troubleshooting).

## 3. Configuration

Set these in your environment. They work the same for both adapters.

| variable | | |
|---|---|---|
| `SANDBOX_AUTH_CLIENT_ID` | **required** | your client id, registered with auth |
| `SANDBOX_AUTH_CLIENT_SESSION_SECRET` | **required** | a long random string that signs your session cookie |
| `SANDBOX_AUTH_ORIGIN` | optional | defaults to `https://auth.sandbox.is` |
| `SANDBOX_AUTH_CLIENT_SESSION_TTL` | optional | how long a session lasts, in seconds; defaults to 30 days |
| `SANDBOX_AUTH_BYPASS` | optional | for testing against a protected preview of auth; leave unset in production |

Set them wherever your host keeps environment variables, for the build as well as at run time.

Serve your app over HTTPS in production. The session cookie uses the `__Host-` prefix, which requires it. On a plain http dev server the cookie name changes automatically, so local development still works.

Both required names start with `SANDBOX_AUTH_CLIENT_` because your app is a client of Sandbox Auth: `CLIENT_ID` is how auth knows you, and `CLIENT_SESSION_SECRET` signs the session cookie you keep on your own side.

You can also pass any of these in code instead of the environment. Every entry point accepts an overrides object: `{ clientId, sessionSecret, authOrigin, sessionTtl, cookieName, callbackPath }`.

---

## Read who's signed in

**Next.js** — in a server component, route handler, or server action:

```ts
import { getSession } from "sandbox-auth/next";

const member = await getSession(); // { sub, name, email, picture?, phone_number?, member_data?, iat } | null
```

**Node** — from the request:

```js
const member = await sandbox.getSession(req); // { sub, name, email, picture?, phone_number?, member_data?, iat } | null
```

`member.sub` is the person's Sandbox id. Use it to find their role in your own data:

```ts
const member = await getSession();
if (!member) return redirect("/login");
const { role } = await db.members.findBySub(member.sub); // your table, your rules
```

With no session cookie, `getSession` returns `null` without needing any configuration, so pages build and render before your app has its client id.

### Profile fields

An app a member built can ask for these profile fields when it's linked. Each one reaches your app in `member.member_data` unless the person switched it off when they signed in, and only if they've filled it in:

| key | what it holds |
|---|---|
| `preferred_name` | the name they'd like to be called |
| `current_city` | the city they live in now |
| `current_hub` | the name of their current Sandbox hub |
| `entry_hub` | the name of the hub they joined through |
| `member_since` | when they became a member |
| `date_of_birth` | `YYYY-MM-DD`, or `--MM-DD` if they hide their birth year |

```ts
const city = member.member_data?.current_city; // undefined unless they shared it
```

## Gate pages

In **Next.js**, protect pages with a proxy (what Next.js 15 and earlier called middleware; use `middleware.ts` and name the function `middleware` there). It does three things: let public paths through, read the session from the cookie, and send anyone without one to `/login`, remembering where they were going in `?next=`. Because it runs on every request, it's also where a Sandbox sign-out gets caught, before the page loads.

The proxy can't use `next/headers`, so it reaches for the `core` functions directly. Copy this and edit `PUBLIC` for your app:

```ts
// proxy.ts, next to your app directory
import { NextRequest, NextResponse } from "next/server";
import { resolveConfig, readSession, revoked, sessionToken } from "sandbox-auth/core";

const PUBLIC = ["/login", "/api/auth"];

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();

  // The cookie first: without one there's nothing to check, and this works
  // before your app has its client id.
  const token = sessionToken(request.cookies);
  let signedIn = false;
  if (token) {
    const cfg = resolveConfig();
    const session = await readSession(cfg, token);
    signedIn = session !== null && !(await revoked(cfg, session));
  }

  // No session, or one from before a Sandbox sign-out → back to login.
  if (!signedIn) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
```

On a plain **Node** server there's no separate step. Call `sandbox.getSession(req)` at the top of each protected handler — it runs the same sign-out check — and redirect when it returns `null`.

---

## Sign out

Signing out can mean two things: leaving your app, or leaving Sandbox entirely.

**Leave your app** — clear the local session cookie. In a Next.js route handler, `signOut` clears it on the response, and `signOutUrl` gives you the Sandbox sign-out URL to hand back:

```ts
import { NextResponse } from "next/server";
import { signOut, signOutUrl } from "sandbox-auth/next";

export async function POST() {
  const home = "https://your-property/";
  const res = NextResponse.json({ endSessionUrl: signOutUrl({}, home) });
  signOut(res, {}, home); // clears the session cookie
  return res;
}
```

Node:

```js
const authSignOutUrl = sandbox.signOut(req, res); // clears the cookie, returns the auth sign-out URL
```

**Leave Sandbox too** — send the person to the URL those calls return. Auth shows a "Sign out of Sandbox?" page and ends the central session. Offer it as a second step, once your app's logout finishes:

```ts
const { endSessionUrl } = await (await fetch("/api/auth/logout", { method: "POST" })).json();
window.location.href = endSessionUrl;
```

### Signing out of Sandbox signs out everywhere

When someone signs out of Sandbox, their session ends in every app, not just the one they were in. Auth records the sign-out, and both `getSession` and the page check treat any session created before it as signed out. The cookie itself stays until it expires or your app clears it with `signOut`. The same thing happens when an admin removes a member.

- `getSession` does this automatically, in both adapters. In the Next.js proxy, call `revoked(cfg, session)` yourself, as shown above.
- The check calls a small, cached endpoint on auth, so it's fast and rarely reaches auth itself.
- If it can't reach auth, it treats the session as still valid — an auth outage never locks people out of your app. The session's normal expiry is the backstop.
- It takes effect within about 15 seconds. A login after the sign-out is newer, so it isn't affected.

*Added in v0.4.0.*

---

## API

**`sandbox-auth/next`**

| | |
|---|---|
| `GET(request)` | the default callback handler — `export { GET } from "sandbox-auth/next"` |
| `callback(overrides?)` | a callback handler with explicit config |
| `getSession(overrides?)` | the signed-in member, or `null` |
| `signOut(response, overrides?, postLogout?)` | clears the cookie on `response`, returns the auth sign-out URL |
| `signOutUrl(overrides?, postLogout?)` | the auth sign-out URL |

**`sandbox-auth/node`** — `sandboxAuth(overrides?)` returns `{ cfg, handleCallback(req, res), getSession(req), signOut(req, res) }`.

**`sandbox-auth/core`** — the building blocks the adapters use, and what you reach for in the proxy: `resolveConfig`, `sessionToken`, `cookieName`, `readSession`, `revoked`, `completeSignIn`, `endSessionUrl`. `sessionToken(cookies)` reads the session cookie without needing any configuration.

---

## Troubleshooting

| what you see | what it means |
|---|---|
| no button on the login page | auth doesn't know the client id: it's mistyped, or the app isn't approved yet. The browser console says which id. |
| auth says the app isn't one it knows (`invalid_client`) | the same: the id your app sends isn't a linked, approved app |
| auth refuses the return address (`invalid_redirect_uri`) | the callback URL your app sends isn't the one you linked: check the path in `callbackPath` and `data-callback`, and that you're on an address you linked |
| back at login with `error=access_denied` | the person chose Cancel when asked to share their details |
| back at login with `error=state_mismatch` or `no_transaction` | the sign-in started in another tab or browser, or took too long; starting again fixes it |
| back at login with `error=invalid_grant`, `token_invalid` or `nonce_mismatch` | the code was used twice or went stale; starting again fixes it. If it keeps happening, check the clock on your server. |
| signed in, but `getSession` returns `null` | `SANDBOX_AUTH_CLIENT_SESSION_SECRET` differs between where the cookie was set and where it's read, or changed since |
| `getSession` throws "set SANDBOX_AUTH_CLIENT_ID" | someone has a session cookie but the app has no client id configured where that code runs |

## How it's designed

- **No client secret.** Your app doesn't hold one. Auth only returns people to a URL you registered ahead of time, and the sign-in uses PKCE — together those keep it secure.
- **Identity is central, permissions are local.** Auth says who someone is; your app decides what they can do.
- **Separate sessions.** Each app has its own session cookie, tied to its own domain. One subdomain can't read or change another's.
