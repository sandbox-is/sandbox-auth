import type { SandboxConfig } from "./index";
export function sandboxProxy(
  request: Request,
  options?: SandboxConfig & { publicPaths?: string[]; loginPath?: string },
): Promise<Response>;
