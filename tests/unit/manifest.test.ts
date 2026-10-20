import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createManifest, extensionIdFor } from '../../scripts/build.mjs';

const devKey = readFileSync(join(import.meta.dirname, '..', '..', 'config', 'extension-public-key.txt'), 'utf8').trim();

describe('manifest', () => {
  it('asks only for what the extension uses', () => {
    const manifest = createManifest({ e2e: false, publicKey: devKey });
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(['storage', 'alarms']);
    expect(manifest.host_permissions).toEqual(['https://github.com/*', 'https://api.github.com/*']);
    expect(manifest.content_scripts).toEqual([{ matches: ['https://github.com/*'], js: ['content.js'], run_at: 'document_idle' }]);
    expect(JSON.stringify(manifest)).not.toMatch(/127\.0\.0\.1|localhost|<all_urls>|tabs|identity|cookies|webRequest|scripting/);
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(140);
    expect(manifest.externally_connectable).toEqual({ ids: [] });
  });

  it('adds the local mock host only to the test build', () => {
    expect(createManifest({ e2e: true, publicKey: devKey }).host_permissions).toContain('http://127.0.0.1/*');
  });

  it('leaves the key out of the Chrome Web Store build (the store rejects it and assigns its own ID)', () => {
    const manifest = createManifest({ e2e: false, publicKey: '' });
    expect('key' in manifest).toBe(false);
    expect([...String(manifest.description)].length).toBeLessThanOrEqual(132); // Web Store limit
  });

  it('pins one extension ID across devices with the committed public key', () => {
    expect(createManifest({ e2e: false, publicKey: devKey }).key).toBe(devKey);
    expect(extensionIdFor(devKey)).toMatch(/^[a-p]{32}$/);
    expect(devKey).not.toMatch(/PRIVATE/);
  });
});
