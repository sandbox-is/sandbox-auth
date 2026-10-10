import type { SandboxConfig, SandboxMember } from "./index";
export function GET(request: Request): Promise<Response>;
export function callback(overrides?: SandboxConfig): (request: Request) => Promise<Response>;
export function getSession(overrides?: SandboxConfig): Promise<SandboxMember | null>;
export function getMemberPass(overrides?: SandboxConfig): Promise<string | null>;
export function signOutUrl(overrides?: SandboxConfig, postLogout?: string): string;
export function signOut(response: unknown, overrides?: import("./index").SandboxConfig, postLogout?: string): string;
