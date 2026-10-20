// Builds the unpacked extension.
//   node scripts/build.mjs          -> dist/      (production: official GitHub endpoints only)
//   node scripts/build.mjs --e2e    -> dist-e2e/  (test build: API/OAuth bases point at the local mock server)
//   node scripts/build.mjs --store  -> dist-store/ and release/github-repo-navigator-<version>.zip
//                                      (Chrome Web Store upload: the production build without the "key" field,
//                                      which the store rejects; the store assigns the extension its own ID)
//
// Configuration (none of it is secret, all of it stays out of git):
//   GRN_GITHUB_CLIENT_ID       GitHub App client ID (Iv1.* / Iv23*). Can also be set at runtime in Options.
//   GRN_GITHUB_APP_SLUG        GitHub App slug, used for "install on another account" links.
//   GRN_EXTENSION_PUBLIC_KEY   Base64 SubjectPublicKeyInfo that pins the extension ID across devices.
// or the same values in config/extension.config.json (see config/extension.config.example.json).
// Without an explicit key the committed development key (config/extension-public-key.txt) is used, so every
// machine that loads the unpacked build gets the same extension ID, which Chrome Sync needs. Its private key was
// never kept: unpacked loading does not need it, and a Chrome Web Store listing would bring its own key.
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIcon } from './icons.mjs';
import { zipDirectory } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = process.argv.includes('--e2e');
const store = !e2e && process.argv.includes('--store');
const outdir = join(root, e2e ? 'dist-e2e' : store ? 'dist-store' : 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

export const E2E_PORT = Number(process.env.GRN_E2E_PORT ?? 4517);

function loadConfig() {
  const file = join(root, 'config', 'extension.config.json');
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const pick = (env, key) => (process.env[env] ?? fromFile[key] ?? '').trim();
  const devKeyFile = join(root, 'config', 'extension-public-key.txt');
  const devKey = existsSync(devKeyFile) ? readFileSync(devKeyFile, 'utf8').trim() : '';
  const config = {
    clientId: pick('GRN_GITHUB_CLIENT_ID', 'githubClientId'),
    appSlug: pick('GRN_GITHUB_APP_SLUG', 'githubAppSlug'),
    publicKey: pick('GRN_EXTENSION_PUBLIC_KEY', 'extensionPublicKey') || devKey,
  };
  if (config.clientId && !/^Iv[A-Za-z0-9.]{6,62}$/.test(config.clientId)) {
    throw new Error('GitHub App client ID has an unexpected format (it starts with "Iv"). It must be the public client ID, never the client secret.');
  }
  if (config.appSlug && !/^[a-z0-9-]{1,100}$/.test(config.appSlug)) {
    throw new Error('GitHub App slug must be lowercase letters, digits and hyphens.');
  }
  if (config.publicKey && !/^[A-Za-z0-9+/=]{100,1200}$/.test(config.publicKey)) {
    throw new Error('Extension public key must be the base64 DER public key (not a PEM private key).');
  }
  return config;
}

/** Chrome derives the extension ID from the public key: first 16 bytes of SHA-256(DER), hex digits mapped to a-p. */
export function extensionIdFor(publicKey) {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function createManifest({ e2e: isE2e, publicKey }) {
  const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
  const manifest = {
    manifest_version: 3,
    name: isE2e ? 'GitHub Repo Navigator (e2e)' : 'GitHub Repo Navigator',
    version: pkg.version,
    description: 'Every GitHub repository you can access, organized into your own synced sections, in GitHub’s menu and dashboard.',
    // 140+: storage.local.setAccessLevel keeps the token store away from content scripts.
    minimum_chrome_version: '140',
    permissions: ['storage', 'alarms'],
    host_permissions: ['https://github.com/*', 'https://api.github.com/*'],
    background: { service_worker: 'background.js', type: 'module' },
    content_scripts: [{ matches: ['https://github.com/*'], js: ['content.js'], run_at: 'document_idle' }],
    options_ui: { page: 'options.html', open_in_tab: true },
    // No other extension and no web page may message this one.
    externally_connectable: { ids: [] },
    action: { default_title: 'GitHub Repo Navigator', default_icon: icons },
    icons,
  };
  if (isE2e) manifest.host_permissions.push('http://127.0.0.1/*');
  if (publicKey) manifest.key = publicKey;
  return manifest;
}

async function main() {
  const config = loadConfig();
  const runtimeConfig = {
    clientId: config.clientId,
    appSlug: config.appSlug,
    apiBase: e2e ? `http://127.0.0.1:${E2E_PORT}/api` : 'https://api.github.com',
    oauthBase: e2e ? `http://127.0.0.1:${E2E_PORT}/oauth` : 'https://github.com',
    e2e,
  };

  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(join(outdir, 'icons'), { recursive: true });

  const common = {
    bundle: true,
    target: 'chrome120',
    legalComments: 'none',
    sourcemap: e2e ? 'inline' : false,
    minify: false,
    define: { __GRN_CONFIG__: JSON.stringify(runtimeConfig) },
    logLevel: 'warning',
  };
  await Promise.all([
    build({ ...common, entryPoints: [join(root, 'src/background/index.ts')], outfile: join(outdir, 'background.js'), format: 'esm' }),
    // Content scripts cannot be ES modules.
    build({ ...common, entryPoints: [join(root, 'src/content/index.ts')], outfile: join(outdir, 'content.js'), format: 'iife' }),
    build({ ...common, entryPoints: [join(root, 'src/options/options.ts')], outfile: join(outdir, 'options.js'), format: 'iife' }),
  ]);

  copyFileSync(join(root, 'src/options/options.html'), join(outdir, 'options.html'));
  copyFileSync(join(root, 'src/options/options.css'), join(outdir, 'options.css'));
  copyFileSync(join(root, 'src/options/force-motion.js'), join(outdir, 'force-motion.js'));
  for (const size of [16, 32, 48, 128]) writeFileSync(join(outdir, 'icons', `icon${size}.png`), renderIcon(size));
  writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(createManifest({ e2e, publicKey: store ? '' : config.publicKey }), null, 2) + '\n');

  const missing = config.clientId ? '' : ' (no GitHub App client ID baked in; set it in Options or GRN_GITHUB_CLIENT_ID)';
  if (store) {
    mkdirSync(join(root, 'release'), { recursive: true });
    const zip = join(root, 'release', `github-repo-navigator-${pkg.version}.zip`);
    const count = zipDirectory(outdir, zip);
    console.log(`Built Chrome Web Store package -> ${zip} (${count} files; no "key": the store assigns the ID)${missing}`);
    return;
  }
  const id = config.publicKey ? ` [extension ID ${extensionIdFor(config.publicKey)}]` : '';
  console.log(`Built ${e2e ? 'e2e' : 'production'} extension -> ${outdir}${id}${missing}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
