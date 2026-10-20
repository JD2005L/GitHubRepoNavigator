/** Build-time configuration injected by scripts/build.mjs (and vitest.config.ts for tests). Nothing secret. */
export interface RuntimeConfig {
  /** GitHub App client ID (public). Empty when the build has none; Options can supply one at runtime. */
  clientId: string;
  /** GitHub App slug for "install on another account" links. */
  appSlug: string;
  apiBase: string;
  oauthBase: string;
  /** True only for the browser-test build that talks to the local mock GitHub. */
  e2e: boolean;
}

declare const __GRN_CONFIG__: RuntimeConfig;

export const CONFIG: RuntimeConfig = __GRN_CONFIG__;
