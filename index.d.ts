/**
 * The profile fields an app a member built can ask for. Each is present only
 * when the app asked for it, the member shared it, and they have filled it in.
 */
export interface SandboxMemberData {
  /** The name they'd like to be called. */
  preferred_name?: string;
  /** The city they live in now. */
  current_city?: string;
  /** The name of their current Sandbox hub. */
  current_hub?: string;
  /** The name of the hub they joined through. */
  entry_hub?: string;
  /** The year they became a member, such as 2016. */
  member_since?: number;
  /** `YYYY-MM-DD`, or `--MM-DD` when they hide their birth year. */
  date_of_birth?: string;
  /** A field added to the directory after this version of the library. */
  [key: string]: unknown;
}
export interface SandboxMember {
  sub: string; name?: string; email?: string; picture?: string; phone_number?: string;
  /** Only for an app a member built: the profile fields the member agreed to share, by key. */
  member_data?: SandboxMemberData;
  iat?: number;
}
export interface SandboxConfig {
  clientId?: string; sessionSecret?: string; authOrigin?: string;
  cookieName?: string; sessionTtl?: number; callbackPath?: string; bypass?: string;
  retryPath?: string;
}
