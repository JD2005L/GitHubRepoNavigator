import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { MockGitHub } from '../../tests/helpers/mockGithub';
import { harnessHtml } from '../harness';
import { startMockServer } from '../mockServer';

/**
 * Chrome Web Store screenshots: five 1280x800 slides, each a caption plus a real capture of the extension
 * (dist-e2e against the mock GitHub) showing a made-up account. No real account or repository appears.
 * Run with `npm run package:screenshots`; output goes to release/chrome-web-store-<version>/images/screenshots/.
 */

const root = join(import.meta.dirname, '..', '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const OUT = join(root, 'release', `chrome-web-store-${version}`, 'images', 'screenshots');
const EXTENSION = join(root, 'dist-e2e');
const CLIENT_ID = 'Iv23liQx7Nb3kP2sY9Ta';
const LOGIN = 'maya-chen';

// ---- Sample account -------------------------------------------------------------------------------------------

interface Sample {
  owner: string;
  name: string;
  description: string;
  language: string;
  topics?: string[];
  private?: boolean;
  archived?: boolean;
  fork?: boolean;
}

const OWNERS: Record<string, { id: number; type: 'User' | 'Organization'; color: string }> = {
  'maya-chen': { id: 71001, type: 'User', color: '#8250df' },
  'northwind-labs': { id: 72002, type: 'Organization', color: '#0969da' },
  'oakridge-studio': { id: 73003, type: 'User', color: '#bf3989' },
};

const SAMPLES: Sample[] = [
  { owner: 'northwind-labs', name: 'api-gateway', description: 'Public API gateway and rate limiting', language: 'Go', private: true },
  { owner: 'northwind-labs', name: 'auth-service', description: 'Sign-in, sessions and SSO', language: 'Go', private: true },
  { owner: 'northwind-labs', name: 'billing-service', description: 'Subscriptions, invoices and payments', language: 'Go', private: true },
  { owner: 'northwind-labs', name: 'web-console', description: 'Customer web console', language: 'TypeScript', private: true },
  { owner: 'northwind-labs', name: 'mobile-app', description: 'iOS and Android app', language: 'Kotlin', private: true },
  { owner: 'northwind-labs', name: 'infra-terraform', description: 'Production infrastructure as code', language: 'HCL', private: true },
  { owner: 'maya-chen', name: 'bluebird-bakery-site', description: 'Website for Bluebird Bakery', language: 'HTML' },
  { owner: 'maya-chen', name: 'harbor-dental-site', description: 'Website for Harbor Dental', language: 'HTML' },
  { owner: 'maya-chen', name: 'summit-law-site', description: 'Website for Summit Law', language: 'HTML', private: true },
  { owner: 'maya-chen', name: 'greenleaf-landscaping', description: 'Website for Greenleaf Landscaping', language: 'CSS' },
  { owner: 'maya-chen', name: 'lakeside-realty', description: 'Listings website for Lakeside Realty', language: 'HTML', private: true },
  { owner: 'maya-chen', name: 'homelab-dashboard', description: 'Homelab service dashboard', language: 'TypeScript', private: true },
  { owner: 'maya-chen', name: 'media-pipeline', description: 'Media transcoding pipeline', language: 'Python', private: true },
  { owner: 'maya-chen', name: 'proxmox-backups', description: 'Nightly Proxmox config backups', language: 'Shell', private: true },
  { owner: 'maya-chen', name: 'home-automation', description: 'Home Assistant automations', language: 'YAML', topics: ['home-assistant'] },
  { owner: 'maya-chen', name: 'dotfiles', description: 'Shell and editor config', language: 'Shell' },
  { owner: 'maya-chen', name: 'git-cleanup-cli', description: 'CLI to prune stale branches', language: 'Rust' },
  { owner: 'maya-chen', name: 'svg-path-editor', description: 'Online editor for SVG paths', language: 'TypeScript', fork: true },
  { owner: 'maya-chen', name: 'old-portfolio', description: 'Previous portfolio website', language: 'HTML', archived: true },
  { owner: 'maya-chen', name: 'weather-bot', description: 'Chat bot for forecasts', language: 'Python', archived: true },
  { owner: 'oakridge-studio', name: 'brand-guidelines', description: 'Brand assets and guidelines', language: 'MDX', private: true },
  { owner: 'maya-chen', name: 'advent-of-code-2025', description: 'Puzzle solutions', language: 'Python' },
  { owner: 'maya-chen', name: 'reading-list', description: 'Books and papers to read', language: 'Markdown' },
  { owner: 'maya-chen', name: 'recipe-box', description: 'Family recipes', language: 'Markdown', private: true },
];

const idOf = (n: number) => 900_000_000 + n * 104_729;
const sampleNumber = (fullName: string) => SAMPLES.findIndex((s) => `${s.owner}/${s.name}` === fullName) + 1;

function sampleRepo(n: number) {
  const s = SAMPLES[n - 1]!;
  const owner = OWNERS[s.owner]!;
  return {
    id: idOf(n),
    node_id: `R_sample${n}`,
    name: s.name,
    full_name: `${s.owner}/${s.name}`,
    private: s.private === true,
    visibility: s.private ? 'private' : 'public',
    owner: { login: s.owner, id: owner.id, type: owner.type, avatar_url: `https://avatars.githubusercontent.com/u/${owner.id}?v=4` },
    description: s.description,
    language: s.language,
    topics: s.topics ?? [],
    fork: s.fork === true,
    archived: s.archived === true,
    pushed_at: new Date(Date.UTC(2026, 8, 1) + n * 86_400_000).toISOString(),
  };
}

const numbers = SAMPLES.map((_, i) => i + 1);
const mock = () =>
  new MockGitHub({
    login: LOGIN,
    userRepos: numbers,
    repo: sampleRepo,
    installations: [
      { id: 81, account: LOGIN, type: 'User', selection: 'all', repos: numbers.filter((n) => SAMPLES[n - 1]!.owner === LOGIN) },
      { id: 82, account: 'northwind-labs', type: 'Organization', selection: 'all', repos: numbers.filter((n) => SAMPLES[n - 1]!.owner === 'northwind-labs') },
    ],
  });

/** The sections shown in the menu screenshots (in this order; Archive collapsed). */
const SECTIONS: { name: string; repos: string[]; collapsed?: boolean }[] = [
  { name: 'Northwind platform', repos: ['api-gateway', 'auth-service', 'billing-service', 'web-console', 'mobile-app', 'infra-terraform'].map((r) => `northwind-labs/${r}`) },
  { name: 'Client websites', repos: ['bluebird-bakery-site', 'harbor-dental-site', 'summit-law-site', 'greenleaf-landscaping', 'lakeside-realty'].map((r) => `maya-chen/${r}`) },
  { name: 'Homelab', repos: ['homelab-dashboard', 'media-pipeline', 'proxmox-backups', 'home-automation'].map((r) => `maya-chen/${r}`) },
  { name: 'Tools', repos: ['dotfiles', 'git-cleanup-cli', 'svg-path-editor'].map((r) => `maya-chen/${r}`) },
  { name: 'Archive', repos: ['old-portfolio', 'weather-bot'].map((r) => `maya-chen/${r}`), collapsed: true },
];

/** Simple initial avatars, so no real person's picture appears. */
function avatarSvg(userId: number): string {
  const entry = Object.entries(OWNERS).find(([, o]) => o.id === userId);
  const [login, owner] = entry ?? ['?', { color: '#57606a' }];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="${owner && 'type' in owner && owner.type === 'Organization' ? 8 : 20}" fill="${owner.color}"/><text x="20" y="27" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="19" font-weight="600" fill="#fff">${login.charAt(0).toUpperCase()}</text></svg>`;
}

// ---- Slides ---------------------------------------------------------------------------------------------------

interface Slide {
  file: string;
  title: string;
  body: string;
  bullets: string[];
  image: Buffer;
  /** CSS size the 2x capture is shown at. */
  width: number;
  height: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function slideHtml(s: Slide, icon: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;width:1280px;height:800px;overflow:hidden;font-family:"Segoe UI",system-ui,-apple-system,sans-serif;color:#f0f6fc;
  background:radial-gradient(1200px 700px at 85% 40%,#1f3a5f 0%,rgba(31,58,95,0) 60%),linear-gradient(135deg,#0d1117 0%,#11161d 55%,#161f2b 100%);display:flex;align-items:center}
.text{width:520px;padding:0 0 0 72px;flex:none}
.brand{display:flex;align-items:center;gap:10px;color:#9198a1;font-size:16px;font-weight:600;margin-bottom:28px}
.brand img{width:28px;height:28px}
h1{font-size:44px;line-height:1.12;margin:0 0 18px;font-weight:700;letter-spacing:-0.5px}
p{font-size:19px;line-height:1.5;color:#c9d1d9;margin:0 0 26px}
ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}
li{font-size:17px;color:#c9d1d9;padding-left:30px;position:relative;line-height:1.4}
li::before{content:"";position:absolute;left:2px;top:6px;width:14px;height:14px;border-radius:50%;background:#4493f8;box-shadow:0 0 0 4px rgba(68,147,248,.18)}
.stage{flex:1;display:flex;align-items:center;justify-content:center;height:800px;padding:40px}
.shot{border-radius:14px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(240,246,252,.12)}
.shot img{display:block;width:${s.width}px;height:${s.height}px}
</style></head><body>
<div class="text"><div class="brand"><img src="data:image/png;base64,${icon}" alt="">GitHub Repo Navigator</div>
<h1>${esc(s.title)}</h1><p>${esc(s.body)}</p><ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>
<div class="stage"><div class="shot"><img src="data:image/png;base64,${s.image.toString('base64')}" alt=""></div></div>
</body></html>`;
}

/** Captures `region` (document coordinates) at 2x, so the slide can show it enlarged and still crisp. */
async function capture(page: Page, region: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  return page.screenshot({ clip: region, fullPage: true, animations: 'disabled', caret: 'hide' });
}

/** An element's box in document coordinates (independent of scrolling). */
async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await locator.waitFor();
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  });
}

// ---- Run ------------------------------------------------------------------------------------------------------

test('Chrome Web Store screenshots', async () => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  const server = await startMockServer(mock());
  const profile = mkdtempSync(join(tmpdir(), 'grn-store-'));
  let colorMode: 'light' | 'dark' = 'light';
  let dashboard = false;
  const context: BrowserContext = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  try {
    await context.route('https://github.com/**', (route) =>
      route.request().resourceType() === 'document'
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: harnessHtml({ colorMode, dashboardSidebar: dashboard }) })
        : route.fulfill({ status: 404, body: '' }),
    );
    await context.route('https://avatars.githubusercontent.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/svg+xml', body: avatarSvg(Number(/\/u\/(\d+)/.exec(route.request().url())?.[1] ?? 0)) }),
    );
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;

    // Connect the sample account.
    const options = await context.newPage();
    await options.emulateMedia({ colorScheme: 'light' });
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.getByRole('button', { name: /^This is my first time/ }).click();
    await options.getByLabel('GitHub App client ID').first().fill(CLIENT_ID);
    await options.getByRole('button', { name: 'Save client ID' }).first().click();
    await options.getByRole('button', { name: 'Connect GitHub' }).click();
    await expect(options.getByText(/Connected as @maya-chen/)).toBeVisible({ timeout: 20_000 });
    await expect(options.getByText(`${SAMPLES.length} repositories ready`, { exact: false })).toBeVisible({ timeout: 20_000 });
    await options.waitForTimeout(800);

    const slides: Slide[] = [];

    // 4. Suggest sections preview (taken first, while everything is uncategorized).
    await options.getByRole('button', { name: 'Suggest sections for me' }).click();
    await expect(options.getByRole('button', { name: /^Create sections/ })).toBeVisible();
    const organize = options.locator('#organize');
    await organize.scrollIntoViewIfNeeded();
    const ob = await box(organize);
    const suggestShot = await capture(options, { x: ob.x, y: ob.y, width: ob.width, height: Math.min(ob.height, 640) });
    await options.getByRole('button', { name: 'Cancel' }).click();

    // Arrange the sample sections through the extension's own layout API.
    await options.evaluate(
      async ({ sections, ids }) => {
        const ops: unknown[] = [];
        sections.forEach((s, i) => {
          const sectionId = `store${i}`;
          ops.push({ type: 'createSection', sectionId, name: s.name, beforeSectionId: 'uncategorized' });
          if (s.collapsed) ops.push({ type: 'setCollapsed', sectionId, collapsed: true });
          for (const r of s.repos) ops.push({ type: 'moveRepo', repoId: ids[r], toSectionId: sectionId, beforeRepoId: null });
        });
        const res = await chrome.runtime.sendMessage<unknown, { ok: boolean; error?: string }>({ type: 'layout/apply', ops });
        if (!res.ok) throw new Error(res.error);
      },
      { sections: SECTIONS, ids: Object.fromEntries(SAMPLES.map((s) => [`${s.owner}/${s.name}`, idOf(sampleNumber(`${s.owner}/${s.name}`))])) },
    );

    // 5. Getting started, finished.
    await options.reload();
    await options.getByRole('tab', { name: 'Setup' }).click();
    const setup = options.locator('#setup');
    await expect(setup.getByRole('heading', { name: 'You’re all set' })).toBeVisible();
    await options.waitForTimeout(800);
    const sb = await box(setup);
    const setupShot = await capture(options, { x: sb.x, y: sb.y, width: sb.width, height: Math.min(sb.height, 560) });

    // 1. The ☰ menu with sections.
    const gh = await context.newPage();
    await gh.goto('https://github.com/');
    await gh.getByRole('button', { name: 'Open global navigation menu' }).click();
    const dialog = gh.getByRole('dialog', { name: 'Global navigation menu' });
    const nav = dialog.locator('[data-grn-host]');
    await expect(nav.locator('.grn-title-count')).toHaveText(String(SAMPLES.length));
    // Let the sync writer finish, so the footer does not show a transient "saving…".
    await expect(nav.locator('.grn-footer')).not.toContainText('saving', { timeout: 15_000 });
    await gh.waitForTimeout(400);
    const db = await box(dialog);
    const nb = await box(nav);
    // From just above the navigator (a little of GitHub's menu for context) to the bottom of the drawer.
    const menuRegion = { x: db.x, y: nb.y - 70, width: db.width, height: Math.min(560, db.y + db.height - (nb.y - 70)) };
    const menuShot = await capture(gh, menuRegion);

    // 2. Filter.
    await nav.getByRole('searchbox', { name: 'Filter repositories' }).fill('site');
    await expect(nav.locator('.grn-repo-link')).toHaveCount(3);
    await gh.waitForTimeout(300);
    const filterRegion = { x: db.x, y: nb.y - 70, width: db.width, height: 300 };
    const filterShot = await capture(gh, filterRegion);
    await gh.close();

    // 3. Dashboard sidebar, dark.
    colorMode = 'dark';
    dashboard = true;
    const dash = await context.newPage();
    await dash.emulateMedia({ colorScheme: 'dark' });
    await dash.goto('https://github.com/');
    // The harness has none of GitHub's stylesheets: give the sidebar GitHub's column width and dark surface.
    await dash.addStyleTag({
      content: `body{background:#0d1117}
        aside[aria-label="Dashboard menu"]{width:320px;background:#010409;border-right:1px solid #3d444d;padding:16px 8px;min-height:1000px}
        aside[aria-label="Dashboard menu"] nav[aria-label="Dashboard"] ul{list-style:none;margin:0 0 12px;padding:0}
        aside[aria-label="Dashboard menu"] nav[aria-label="Dashboard"] a{display:block;padding:6px 10px;border-radius:6px;color:#f0f6fc;text-decoration:none;font:14px "Segoe UI",sans-serif}
        aside[aria-label="Dashboard menu"] nav[aria-label="Dashboard"] a[aria-current]{background:#262c36;font-weight:600}`,
    });
    const aside = dash.locator('aside[aria-label="Dashboard menu"]');
    await expect(aside.locator('[data-grn-host] .grn-title-count')).toHaveText(String(SAMPLES.length));
    await dash.waitForTimeout(600);
    const ab = await box(aside);
    const sidebarShot = await capture(dash, { x: ab.x, y: ab.y, width: ab.width, height: 600 });
    await dash.close();

    const scale = (w: number, h: number, maxW: number, maxH: number) => {
      const k = Math.min(maxW / w, maxH / h);
      return { width: Math.round(w * k), height: Math.round(h * k) };
    };
    slides.push(
      { file: '1-menu-sections.png', title: 'Every repository, right in GitHub’s menu', body: 'Replaces GitHub’s short “Top repositories” list with every repository you can access.', bullets: ['Your own, your organizations’ and shared ones', 'Grouped into sections you control', 'Synced to every Chrome you use'], image: menuShot, ...scale(menuRegion.width, menuRegion.height, 560, 720) },
      { file: '2-filter.png', title: 'Find any repository instantly', body: 'Type a few letters to filter the whole list, across every section.', bullets: ['Matches highlighted as you type', 'Enter opens the first match', 'Fully keyboard-accessible'], image: filterShot, ...scale(filterRegion.width, filterRegion.height, 600, 640) },
      { file: '3-dashboard-sidebar.png', title: 'On your dashboard too', body: 'The dashboard’s sidebar gets the same organized list. Light and dark themes follow GitHub’s.', bullets: ['Same sections in both places', 'Drag to reorder, or use the keyboard', 'Nothing else on GitHub changes'], image: sidebarShot, ...scale(ab.width, 600, 560, 720) },
      { file: '4-suggest-sections.png', title: 'Let it organize for you', body: '“Suggest sections” groups your repositories by name, owner, description and language.', bullets: ['Preview, rename or untick before applying', 'Only touches uncategorized repositories', 'One click to undo'], image: suggestShot, ...scale(ob.width, Math.min(ob.height, 640), 640, 680) },
      { file: '5-setup.png', title: 'Read-only, private, set up in minutes', body: 'A guided checklist connects your account. Access is read-only repository metadata, with no server in between.', bullets: ['Talks only to GitHub', 'Tokens never leave your device', 'No analytics, no tracking'], image: setupShot, ...scale(sb.width, Math.min(sb.height, 560), 640, 660) },
    );

    // Compose each slide at exactly 1280x800, 1x.
    const icon = readFileSync(join(root, 'dist-e2e', 'icons', 'icon128.png')).toString('base64');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
      for (const s of slides) {
        await page.setContent(slideHtml(s, icon));
        await page.waitForLoadState('load');
        writeFileSync(join(OUT, s.file), await page.screenshot({ type: 'png' }));
      }
    } finally {
      await browser.close();
    }
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
    await new Promise((resolve) => server.server.close(resolve));
  }
});
