export const E2E_PORT: number;
export function extensionIdFor(publicKey: string): string;
export function createManifest(options: { e2e: boolean; publicKey: string }): {
  manifest_version: number;
  minimum_chrome_version: string;
  permissions: string[];
  host_permissions: string[];
  content_scripts: { matches: string[]; js: string[]; run_at: string }[];
  key?: string;
  [key: string]: unknown;
};
