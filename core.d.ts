import type { SandboxConfig, SandboxMember } from "./index";
export function resolveConfig(o?: SandboxConfig): Required<SandboxConfig> & { txCookie: string };
export function cookieName(cfg: unknown, secure: boolean): string;
/** The session cookie's value, or null. Needs no config, so it works before the app has a client id. */
export function sessionToken(cookies: { get(name: string): string | { value: string } | undefined }, overrides?: SandboxConfig): string | null;
export function readSession(cfg: unknown, token?: string): Promise<SandboxMember | null>;
export function revoked(cfg: unknown, session?: SandboxMember | null): Promise<boolean>;
export function completeSignIn(a: { cfg: unknown; query: Record<string,string>; cookies: Record<string,string>; redirectUri: string }): Promise<{ member?: SandboxMember; token?: string; next?: string; error?: string }>;
export function endSessionUrl(cfg: unknown, postLogout?: string): string;
/** The member pass behind a session; renews it when `renew` is set, returning the new session token as `token`. */
export function memberPass(cfg: unknown, token?: string, options?: { renew?: boolean }): Promise<{ pass: string | null; token?: string }>;
/** A renewed session token when the pass in this one has run out, or null when nothing needs doing. */
export function renewSession(cfg: unknown, token?: string): Promise<string | null>;
