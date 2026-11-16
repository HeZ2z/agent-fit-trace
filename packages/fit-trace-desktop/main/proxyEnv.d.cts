/** Type declarations for proxyEnv.cjs (plain-CJS Electron parent helper). */
export interface ProxyEnvOptions {
  platform?: NodeJS.Platform;
  readSystemProxy?: () => string | null;
}
export function applyProxyEnv(env: NodeJS.ProcessEnv, options?: ProxyEnvOptions): NodeJS.ProcessEnv;
export function parseMacProxy(text: string): { url: string; bypass: string[] } | null;
