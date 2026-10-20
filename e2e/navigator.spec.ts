import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { renderIcon } from '../scripts/icons.mjs';
import { MockGitHub, releaseFixture } from '../tests/helpers/mockGithub';
import { apiRepo } from '../tests/helpers/repos';
import { harnessHtml } from './harness';
import { startMockServer } from './mockServer';

const EXTENSION = join(import.meta.dirname, '..', 'dist-e2e');
const SHOTS = join(import.meta.dirname, '..', 'test-results', 'screenshots');
const CLIENT_ID = 'Iv23liE2eTestClient';
const AVATAR = renderIcon(32);

interface Device {
  context: BrowserContext;
  extensionId: string;
  profile: string;
  colorMode: 'light' | 'dark';
  /** Serve github.com as the home page with the dashboard sidebar. */
  dashboard: boolean;
  /** The account github.com pages say they are signed in as (none: the page does not say). */
  login?: string;
  /** fetch/XHR requests made to github.com by pages or the content script (must stay empty). */
  githubDataRequests: string[];
}

let server: Awaited<ReturnType<typeof startMockServer>>;

test.beforeAll(async () => {
  server = await startMockServer(releaseFixture());
  mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => {
  await new Promise((resolve) => server.server.close(resolve));
});

/** `extra`: further unpacked copies to load next to the test build (e.g. a store install plus a dev build). */
async function launch(viewport = { width: 1440, height: 900 }, extra: string[] = []): Promise<Device> {
  const profile = mkdtempSync(join(tmpdir(), 'grn-e2e-'));
  const extensions = [EXTENSION, ...extra].join(',');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport,
    args: [`--disable-extensions-except=${extensions}`, `--load-extension=${extensions}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const device: Device = { context, extensionId, profile, colorMode: 'light', dashboard: false, githubDataRequests: [] };
  await context.route('https://github.com/**', async (route) => {
    const type = route.request().resourceType();
    if ((type === 'fetch' || type === 'xhr') && !route.request().serviceWorker()) device.githubDataRequests.push(route.request().url());
    if (type === 'document') {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: harnessHtml({ colorMode: device.colorMode, dashboardSidebar: device.dashboard, login: device.login }) });
    } else {
      await route.fulfill({ status: 404, body: '' });
    }
  });
  await context.route('https://avatars.githubusercontent.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: AVATAR }));
  return device;
}

async function close(device: Device) {
  await device.context.close();
  rmSync(device.profile, { recursive: true, force: true });
}

async function options(device: Device): Promise<Page> {
  const page = await device.context.newPage();
  await page.goto(`chrome-extension://${device.extensionId}/options.html`);
  await expect(page.getByRole('heading', { name: 'GitHub Repo Navigator' })).toBeVisible();
  return page;
}

async function signIn(device: Device, mock: MockGitHub): Promise<Page> {
  server.use(mock);
  mock.deviceSteps = ['pending', 'success'];
  const page = await options(device);
  const firstTime = page.getByRole('button', { name: /^This is my first time/ });
  const connect = page.getByRole('button', { name: 'Connect GitHub' });
  // A device whose client ID already arrived through Chrome Sync starts at Connect.
  await expect(firstTime.or(connect)).toBeVisible();
  if (await firstTime.isVisible()) {
    await firstTime.click();
    await page.getByLabel('GitHub App client ID').first().fill(CLIENT_ID);
    await page.getByRole('button', { name: 'Save client ID' }).first().click();
  }
  await connect.click();
  await expect(page.locator('.code')).toHaveText('WDJB-MJHT');
  await expect(page.getByText('Only enter a code that this page shows you')).toBeVisible();
  await expect(page.getByText(/Connected as @jd2005l/)).toBeVisible({ timeout: 20_000 });
  return page;
}

async function openDrawer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open global navigation menu' }).click();
  const dialog = page.getByRole('dialog', { name: 'Global navigation menu' });
  await expect(dialog).toBeVisible();
  const nav = dialog.locator('[data-grn-host] .grn');
  return nav;
}

async function githubPage(device: Device): Promise<Page> {
  const page = await device.context.newPage();
  await page.goto('https://github.com/');
  return page;
}

const rows = (nav: Locator) => nav.locator('.grn-repo-link');
const githubGroup = (page: Page) => page.locator('li[data-component="ActionList.Group"]').filter({ has: page.locator('h3', { hasText: 'Top repositories' }) });
const repoText = (n: number) => `${apiRepo(n).owner.login}/${apiRepo(n).name}`;
const repoRow = (nav: Locator, n: number) => nav.locator(`[data-repo-id="${apiRepo(n).id}"]`);

async function dragTo(page: Page, source: Locator, target: Locator, position: 'top' | 'center' | 'bottom' = 'center') {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  const y = position === 'top' ? to.y + 4 : position === 'bottom' ? to.y + to.height - 4 : to.y + to.height / 2;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 3, from.y + from.height / 2 + 8, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, y, { steps: 12 });
  await page.mouse.up();
}

async function syncItems(device: Device): Promise<Record<string, unknown>> {
  const page = await options(device);
  const items = await page.evaluate(() => chrome.storage.sync.get(null));
  await page.close();
  return items;
}

test.describe.serial('GitHub Repo Navigator in Chromium', () => {
  let device: Device;
  let mock: MockGitHub;
  /** [in Work, in Side projects], recorded by the editing test for the later persistence/sync checks. */
  const movedIds: number[] = [];

  test.beforeAll(async () => {
    device = await launch();
    mock = releaseFixture();
  });
  test.afterAll(async () => close(device));

  test('keeps GitHub’s list and offers setup while signed out', async () => {
    const page = await githubPage(device);
    const nav = await openDrawer(page);
    await expect(nav.getByText('Repo Navigator needs setup')).toBeVisible();
    await expect(githubGroup(page)).toBeVisible();
    await expect(githubGroup(page).locator('a[data-testid="dynamic-side-panel-items-item"]')).toHaveCount(7);
    await page.close();
  });

  test('signs in with the device flow and fetches every page of the inventory', async () => {
    const page = await signIn(device, mock);
    await page.getByRole('tab', { name: 'Repositories & sync' }).click();
    await expect(page.locator('dl.facts').first()).toBeVisible();
    await expect(page.getByText('255', { exact: true })).toBeVisible({ timeout: 20_000 });
    const pages = mock.log.filter((r) => r.path === '/api/user/repos').map((r) => new URLSearchParams(r.query).get('page') ?? '1');
    expect(pages).toEqual(['1', '2', '3']);
    expect(mock.log.filter((r) => r.path === '/api/user/repos').every((r) => new URLSearchParams(r.query).get('per_page') === '100')).toBe(true);
    expect(mock.tokenRequests.every((r) => !('client_secret' in r))).toBe(true);
    await page.close();
  });

  test('replaces only Top repositories with the complete inventory (225+ across pages, not GitHub’s 7)', async () => {
    const page = await githubPage(device);
    const nav = await openDrawer(page);
    await expect(rows(nav)).toHaveCount(255);
    await expect(githubGroup(page)).toBeHidden();
    // The rest of GitHub's drawer is untouched and visible.
    for (const name of ['Home', 'Explore', 'Marketplace']) await expect(page.getByRole('dialog').getByRole('link', { name, exact: true })).toBeVisible();
    // Items from the third /user/repos page and from an installation-only page are present.
    for (const n of [205, 225, 240, 255]) await expect(repoRow(nav, n)).toHaveCount(1);
    // GitHub's own DOM list (7 items + Show more) is untouched: it is not where our data came from. Nothing clicked
    // Show more, and neither the page nor the content script fetched anything from github.com (no internal
    // side-panel endpoints); the 255 repositories came only from the REST API mock.
    await expect(githubGroup(page).locator('a[data-testid="dynamic-side-panel-items-item"]')).toHaveCount(7);
    expect(await page.evaluate(() => (window as unknown as { grnTest: { showMoreClicks: number } }).grnTest.showMoreClicks)).toBe(0);
    expect(device.githubDataRequests).toEqual([]);
    await expect(nav.locator('.grn-title-count')).toHaveText('255');
    await page.screenshot({ path: join(SHOTS, 'flow-complete-inventory-1440x900.png') });
    await page.close();
  });

  test('replaces the dashboard sidebar’s Top repositories too, and the page stays responsive', async () => {
    device.dashboard = true;
    try {
      const page = await githubPage(device);
      const sidebar = page.locator('aside[aria-label="Dashboard menu"]');
      const nav = sidebar.locator('[data-grn-host] .grn');
      await expect(rows(nav)).toHaveCount(255);
      await expect(sidebar.locator('nav[data-testid="dashboard-repositories"] li[data-component="ActionList.Group"]')).toBeHidden();
      await expect(sidebar.getByRole('link', { name: 'Feed', exact: true })).toBeVisible();
      // A freeze (mutation feedback loop) shows up as the page never answering.
      const ticks = await page.evaluate(() => new Promise<number>((resolve) => {
        let n = 0;
        const t = setInterval(() => n++, 10);
        setTimeout(() => (clearInterval(t), resolve(n)), 500);
      }));
      expect(ticks).toBeGreaterThan(20);
      // Both places at once: the drawer still gets its own navigator.
      const drawerNav = await openDrawer(page);
      await expect(rows(drawerNav)).toHaveCount(255);
      await expect(page.locator('[data-grn-host]')).toHaveCount(2);
      await page.screenshot({ path: join(SHOTS, 'flow-dashboard-sidebar-1440x900.png') });
      await page.close();
    } finally {
      device.dashboard = false;
    }
  });

  test('searches the full cached inventory', async () => {
    const page = await githubPage(device);
    const nav = await openDrawer(page);
    const search = nav.getByRole('searchbox', { name: 'Filter repositories' });
    await search.fill(apiRepo(250).name);
    await expect(rows(nav)).toHaveCount(1);
    await expect(rows(nav).first()).toContainText(repoText(250));
    await search.press('Escape');
    await expect(rows(nav)).toHaveCount(255);
    await expect(page.getByRole('dialog')).toBeVisible(); // Escape cleared the filter instead of closing the drawer
    await page.close();
  });

  test('creates sections, drags repositories between and within them, and moves them by keyboard', async () => {
    const page = await githubPage(device);
    const nav = await openDrawer(page);
    await nav.getByRole('button', { name: 'New section' }).click();
    await nav.getByRole('textbox', { name: 'New section name' }).fill('Work');
    await nav.getByRole('textbox', { name: 'New section name' }).press('Enter');
    await expect(nav.locator('.grn-section-name').first()).toHaveText('Work');
    const work = nav.locator('.grn-section').first();

    // Drag the first two Uncategorized rows (visible without scrolling) into the empty section, one below the other.
    const unc = nav.locator('.grn-section[data-automatic]');
    const idA = Number(await unc.locator('.grn-repo').nth(0).getAttribute('data-repo-id'));
    const idB = Number(await unc.locator('.grn-repo').nth(1).getAttribute('data-repo-id'));
    const row = (id: number) => nav.locator(`[data-repo-id="${id}"]`);
    const textA = (await row(idA).locator('.grn-repo-text').textContent())!;
    const textB = (await row(idB).locator('.grn-repo-text').textContent())!;
    await dragTo(page, row(idA), work.locator('.grn-empty'));
    await expect(work.locator('.grn-repo')).toHaveCount(1);
    await dragTo(page, row(idB), work.locator('.grn-repo').first(), 'bottom');
    await expect(work.locator('.grn-repo-text')).toHaveText([textA, textB]);
    // Reorder within the section.
    await dragTo(page, row(idB), row(idA), 'top');
    await expect(work.locator('.grn-repo-text')).toHaveText([textB, textA]);
    // A drag must not navigate.
    expect(page.url()).toBe('https://github.com/');

    // Keyboard: Alt+ArrowDown moves the focused repository down; focus stays on it.
    await row(idB).locator('a').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(work.locator('.grn-repo-text')).toHaveText([textA, textB]);
    await expect(row(idB).locator('a')).toBeFocused();

    // Move via the actions menu into a new section.
    await row(idB).getByRole('button', { name: `Move ${textB}` }).click();
    await nav.getByRole('menuitem', { name: /New section/ }).click();
    await nav.getByRole('textbox', { name: 'New section name' }).fill('Side projects');
    await nav.getByRole('textbox', { name: 'New section name' }).press('Enter');
    await expect(nav.locator('.grn-section-name')).toHaveText(['Work', 'Side projects', 'Uncategorized']);
    await expect(nav.locator('.grn-section').nth(1).locator('.grn-repo-text')).toHaveText([textB]);
    movedIds.push(idA, idB);

    // Reorder sections by dragging the grip.
    const sideHeader = nav.locator('.grn-section').nth(1).locator('.grn-section-header');
    await sideHeader.hover();
    await dragTo(page, sideHeader.locator('.grn-grip'), nav.locator('.grn-section').first().locator('.grn-section-header'), 'top');
    await expect(nav.locator('.grn-section-name')).toHaveText(['Side projects', 'Work', 'Uncategorized']);

    // Deleting a non-empty section is disabled and explained.
    await nav.getByRole('button', { name: 'Actions for section Work' }).click();
    const del = nav.getByRole('menuitem', { name: /Delete section/ });
    await expect(del).toHaveAttribute('aria-disabled', 'true');
    await expect(del).toContainText('Only empty sections can be deleted. Move its 1 repository to another section first.');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeVisible();

    // Collapse Work.
    await nav.locator('[data-section-toggle]').filter({ hasText: 'Work' }).click();
    await expect(nav.locator('[data-section-toggle]').filter({ hasText: 'Work' })).toHaveAttribute('aria-expanded', 'false');
    await page.close();
  });

  test('persists sections, order and collapsed state across reloads and drawer re-opens', async () => {
    const page = await githubPage(device);
    let nav = await openDrawer(page);
    await expect(nav.locator('.grn-section-name')).toHaveText(['Side projects', 'Work', 'Uncategorized']);
    await expect(nav.locator('[data-section-toggle]').filter({ hasText: 'Work' })).toHaveAttribute('aria-expanded', 'false');
    // Re-open several times and soft-navigate: always exactly one navigator.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => (window as unknown as { grnTest: { close(): void } }).grnTest.close());
      await expect(page.locator('[data-grn-host]')).toHaveCount(0);
      nav = await openDrawer(page);
      await expect(rows(nav).first()).toBeVisible();
      await expect(page.locator('[data-grn-host]')).toHaveCount(1);
    }
    await page.evaluate(() => (window as unknown as { grnTest: { softNav(): void; rerenderGithubGroup(): void } }).grnTest.softNav());
    await page.evaluate(() => (window as unknown as { grnTest: { rerenderGithubGroup(): void } }).grnTest.rerenderGithubGroup());
    await expect(page.locator('[data-grn-host]')).toHaveCount(1);
    await expect(githubGroup(page)).toBeHidden();
    await page.close();
  });

  test('syncs only compact organization data, never tokens or repository details', async () => {
    // Give the debounced writer time to flush.
    await expect.poll(async () => 'grn:h' in (await syncItems(device)), { timeout: 20_000 }).toBe(true);
    const items = await syncItems(device);
    // Sections (grn:*), plus the client ID and the start choice so another browser only has to connect, and
    // which account the sections belong to (a GitHub user ID).
    expect(Object.keys(items).every((k) => k.startsWith('grn:') || k === 'config.clientId' || k === 'onboarding' || k === 'layout.owner')).toBe(true);
    expect(items['layout.owner']).toBe(1001);
    expect(items['config.clientId']).toBe(CLIENT_ID);
    const text = JSON.stringify(items);
    expect(text).not.toMatch(/ghu_|ghr_|token|avatar|github\.com|gateway|portal/i);
    expect(text).toContain('Side projects');
    for (const id of movedIds) expect(text).toContain(id.toString(36));
    const page = await options(device);
    const local = await page.evaluate(() => chrome.storage.local.get(null));
    expect(Object.keys(local)).toEqual(expect.arrayContaining(['auth.accounts', 'acct.1001.auth.tokens', 'acct.1001.inventory.cache', 'acct.1001.layout.mirror']));
    await page.close();
  });

  test('applies the synced sections to a second device’s own inventory', async () => {
    const synced = await syncItems(device);
    const second = await launch();
    try {
      // Device 2 sees a different set of repositories: the one in "Side projects" but not the one in "Work".
      const [inWork, inSide] = movedIds.map((id) => (id - 500_000_000) / 7919) as [number, number];
      const others = Array.from({ length: 255 }, (_, i) => i + 1).filter((n) => n !== inWork && n !== inSide).slice(0, 160);
      const other = new MockGitHub({ userRepos: [inSide, ...others] });
      const setup = await options(second);
      await setup.evaluate((items) => chrome.storage.sync.set(items), synced);
      // The synced client ID skips straight to Connect: nothing about creating an app.
      await expect(setup.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
      await expect(setup.getByRole('button', { name: /^This is my first time/ })).toHaveCount(0);
      await setup.close();
      const page2 = await signIn(second, other);
      await page2.close();
      const page = await githubPage(second);
      const nav = await openDrawer(page);
      await expect(nav.locator('.grn-section-name')).toHaveText(['Side projects', 'Work', 'Uncategorized']);
      await expect(nav.locator('.grn-section').first().locator('.grn-repo-text')).toHaveText([repoText(inSide)]);
      await nav.locator('[data-section-toggle]').filter({ hasText: 'Work' }).click();
      await expect(nav.locator('.grn-section').nth(1).getByText('1 more not available on this device')).toBeVisible();
      await expect(rows(nav)).toHaveCount(161);
      await page.close();
    } finally {
      await close(second);
      server.use(mock);
    }
  });

  test('shows rate-limit, offline and expired states while keeping the saved list', async () => {
    const page = await githubPage(device);
    let nav = await openDrawer(page);
    mock.failure = { kind: 'rate-limit', resetEpochSeconds: Math.floor(Date.now() / 1000) + 900 };
    await nav.getByRole('button', { name: 'Refresh repositories' }).click();
    await expect(nav.locator('.grn-banner')).toContainText('rate limit');
    await expect(rows(nav)).toHaveCount(255);

    mock.failure = { kind: 'network' };
    await nav.getByRole('button', { name: 'Refresh repositories' }).click();
    await expect(nav.locator('.grn-banner')).toContainText('unreachable');
    await expect(rows(nav)).toHaveCount(255);

    mock.failure = null;
    mock.issuedToken = 'ghu_revoked_elsewhere'; // the user revoked the app on GitHub
    mock.refreshAccepted = false;
    await page.evaluate(() => (window as unknown as { grnTest: { close(): void } }).grnTest.close());
    nav = await openDrawer(page);
    await nav.getByRole('button', { name: 'Refresh repositories' }).click();
    await expect(nav.locator('.grn-banner')).toContainText('authorization expired');
    await expect(rows(nav)).toHaveCount(255);
    await page.screenshot({ path: join(SHOTS, 'drawer-expired-1440x900.png') });
    await page.close();
  });
});

test.describe('visual check at the target and adjacent viewports', () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    for (const colorMode of ['light', 'dark'] as const) {
      test(`${viewport.width}x${viewport.height} ${colorMode}`, async () => {
        const device = await launch(viewport);
        device.colorMode = colorMode;
        try {
          const mock = releaseFixture();
          const setup = await signIn(device, mock);
          await setup.close();
          const page = await githubPage(device);
          const nav = await openDrawer(page);
          await expect(rows(nav)).toHaveCount(255);
          await nav.getByRole('button', { name: 'New section' }).click();
          await nav.getByRole('textbox', { name: 'New section name' }).fill('Client work');
          await nav.getByRole('textbox', { name: 'New section name' }).press('Enter');
          await repoRow(nav, 4).getByRole('button').click();
          await nav.getByRole('menuitem', { name: 'Client work' }).click();
          await repoRow(nav, 8).getByRole('button').click();
          await nav.getByRole('menuitem', { name: 'Client work' }).click();
          await expect(nav.locator('.grn-section').first().locator('.grn-repo')).toHaveCount(2);
          // No horizontal overflow inside the drawer.
          const overflow = await page.getByRole('dialog').evaluate((d) => d.scrollWidth - d.clientWidth);
          expect(overflow).toBeLessThanOrEqual(1);
          const fg = await nav.evaluate((el) => getComputedStyle(el).color);
          expect(fg).toBe(colorMode === 'dark' ? 'rgb(240, 246, 252)' : 'rgb(31, 35, 40)');
          await page.screenshot({ path: join(SHOTS, `drawer-${viewport.width}x${viewport.height}-${colorMode}.png`), animations: 'disabled' });
          await page.close();
        } finally {
          await close(device);
        }
      });
    }
  }
});

test.describe.serial('organizing automatically and moving sections between browsers', () => {
  let device: Device;
  let page: Page;
  const sectionNames = () =>
    page.evaluate(async () => {
      const res = await chrome.runtime.sendMessage<unknown, { data: { layout: { layout: { sections: { name: string; repoIds: number[] }[] } } } }>({ type: 'nav/get' });
      return res.data.layout.layout.sections.map((s) => `${s.name}:${s.repoIds.length}`);
    });

  test.beforeAll(async () => {
    device = await launch();
    page = await signIn(device, releaseFixture());
    await expect(page.getByRole('heading', { name: 'How do you want to start?' })).toBeVisible({ timeout: 20_000 });
  });
  test.afterAll(async () => close(device));

  test('asks how to start in the GitHub menu too, and its Suggest sections opens the preview', async () => {
    const github = await githubPage(device);
    const nav = await openDrawer(github);
    const start = nav.locator('.grn-start');
    await expect(start).toContainText('How do you want to start?');
    await expect(rows(nav)).toHaveCount(255);
    await github.screenshot({ path: join(SHOTS, 'drawer-start-choice.png') });
    const [suggestPage] = await Promise.all([device.context.waitForEvent('page'), start.getByRole('button', { name: 'Suggest sections' }).click()]);
    await expect(suggestPage.getByRole('tab', { name: /^Organize/ })).toHaveAttribute('aria-selected', 'true');
    await expect(suggestPage.getByRole('button', { name: /^Create sections/ })).toBeVisible({ timeout: 20_000 });
    expect(new URL(suggestPage.url()).hash).toBe('#organize');
    await suggestPage.close();
    await github.close();
    expect(await sectionNames()).toEqual(['Uncategorized:0']); // nothing changes until Create
  });

  test('suggests sections from a preview, applies them, and undoes them exactly', async () => {
    await page.getByRole('button', { name: 'Suggest sections for me' }).click();
    await expect(page.getByRole('tab', { name: /^Organize/ })).toHaveAttribute('aria-selected', 'true');
    const create = page.getByRole('button', { name: /^Create sections/ });
    await expect(create).toBeVisible({ timeout: 20_000 });
    // Untick one suggestion and rename another before applying.
    const items = page.locator('ul.suggestions > li');
    expect(await items.count()).toBeGreaterThan(2);
    await items.nth(1).getByRole('checkbox').uncheck();
    await items.first().getByRole('textbox', { name: 'Section name' }).fill('Renamed first');
    await create.click();
    await expect(page.getByText(/^Placed \d+ repositories in \d+ sections\./)).toBeVisible();
    const after = await sectionNames();
    expect(after[0]).toMatch(/^Renamed first:\d+$/);
    expect(after.length).toBeGreaterThan(2);
    await page.screenshot({ path: join(SHOTS, 'flow-suggested-sections.png'), fullPage: true });
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Undone. Those repositories are back in Uncategorized.')).toBeVisible();
    expect(await sectionNames()).toEqual(['Uncategorized:0']);
    // Answered once by creating sections: undoing them does not bring the first-run question back.
    await expect(page.getByRole('heading', { name: 'How do you want to start?' })).toHaveCount(0);
  });

  test('exports sections to a file and imports them back', async () => {
    await page.getByRole('button', { name: 'Suggest sections', exact: true }).click();
    await page.getByRole('button', { name: /^Create sections/ }).click();
    await expect(page.getByText(/^Placed \d+ repositories/)).toBeVisible();
    const before = await sectionNames();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export sections' }).click()]);
    const file = join(device.profile, 'sections.json');
    await download.saveAs(file);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Undone.', { exact: false })).toBeVisible();
    expect(await sectionNames()).toEqual(['Uncategorized:0']);

    await page.locator('#import-file').setInputFiles(file);
    await expect(page.getByText(/would place \d+ repositories/)).toBeVisible();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText(/^Imported \d+ sections with \d+ repositories\./)).toBeVisible();
    expect(await sectionNames()).toEqual(before);
  });

});

test('two installed copies (store + unpacked dev build) share the page instead of fighting over it', async () => {
  // A second copy needs its own extension ID, so it is the same build without the pinned key.
  const copy = mkdtempSync(join(tmpdir(), 'grn-e2e-copy-'));
  cpSync(EXTENSION, copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8'));
  delete manifest.key;
  writeFileSync(join(copy, 'manifest.json'), JSON.stringify(manifest));
  const device = await launch(undefined, [copy]);
  device.dashboard = true;
  try {
    const page = await githubPage(device);
    const sidebar = page.locator('aside[aria-label="Dashboard menu"]');
    await expect(sidebar.locator('[data-grn-host] .grn')).toHaveCount(1);
    // Each copy used to delete the other's navigator and add its own, forever: the page froze.
    const ticks = await page.evaluate(() => new Promise<number>((resolve) => {
      let n = 0;
      const t = setInterval(() => n++, 10);
      setTimeout(() => (clearInterval(t), resolve(n)), 500);
    }));
    expect(ticks).toBeGreaterThan(20);
    await expect(sidebar.locator('[data-grn-host]')).toHaveCount(1);
    const drawer = page.getByRole('dialog', { name: 'Global navigation menu' });
    await openDrawer(page);
    await expect(drawer.locator('[data-grn-host] .grn')).toHaveCount(1);
    await expect(page.locator('[data-grn-host]')).toHaveCount(2);
    await page.close();
  } finally {
    await close(device);
    rmSync(copy, { recursive: true, force: true });
  }
});

test('starting with one list answers the first-run question everywhere', async () => {
  const device = await launch();
  try {
    const page = await signIn(device, releaseFixture());
    await expect(page.getByRole('tab', { name: /Organize \(not organized yet\)/ })).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: join(SHOTS, 'options-start-choice-light.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: join(SHOTS, 'options-start-choice-dark.png'), fullPage: true });
    await page.getByRole('button', { name: 'Start with one list' }).click();
    await expect(page.getByText(/^Starting with one list\./)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How do you want to start?' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Organize', exact: true })).toBeVisible();
    // Tabs: arrow keys move between them, and the choice survives a reload.
    await page.getByRole('tab', { name: 'Setup' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Organize', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Suggest sections', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Organize', exact: true })).toHaveAttribute('aria-selected', 'true');
    const github = await githubPage(device);
    const nav = await openDrawer(github);
    await expect(rows(nav)).toHaveCount(255);
    await expect(nav.locator('.grn-start')).toHaveCount(0);
    await github.close();
    await page.close();
  } finally {
    await close(device);
  }
});

test('another browser reuses the existing GitHub App: no app creation, just the client ID and Connect', async () => {
  const device = await launch();
  try {
    const page = await options(device);
    await expect(page.getByRole('heading', { name: 'Create your GitHub App' })).toBeVisible();
    await page.getByRole('button', { name: /^I already use Repo Navigator in another browser/ }).click();
    await expect(page.getByRole('heading', { name: 'Use your existing GitHub App' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open my GitHub Apps' })).toHaveAttribute('href', 'https://github.com/settings/apps');
    await expect(page.getByText('Open the pre-filled form on GitHub')).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'options-existing-app.png'), fullPage: true });
    // The choice survives a reload (a trip to GitHub and back).
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Use your existing GitHub App' })).toBeVisible();
    await page.getByLabel('GitHub App client ID').first().fill(CLIENT_ID);
    await page.getByRole('button', { name: 'Save client ID' }).first().click();
    await expect(page.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    await page.close();
  } finally {
    await close(device);
  }
});

test('keeps two GitHub accounts apart: each page shows the account it is signed in as', async () => {
  const device = await launch();
  try {
    device.login = 'jd2005l';
    const page = await signIn(device, releaseFixture());
    let github = await githubPage(device);
    let nav = await openDrawer(github);
    await expect(rows(nav)).toHaveCount(255);
    await github.close();

    // GitHub's account switcher: the same browser, now signed in as an account that is not connected here. Its
    // pages must not show the first account's repositories.
    device.login = 'JD-Work';
    github = await githubPage(device);
    nav = await openDrawer(github);
    await expect(nav.getByText('Connect @JD-Work too')).toBeVisible();
    await expect(rows(nav)).toHaveCount(0);
    await expect(githubGroup(github)).toBeVisible();

    // Connecting it in Options (GitHub connects whichever account enters the code) adds it next to the first.
    const work = new MockGitHub({ userRepos: Array.from({ length: 12 }, (_, i) => 301 + i), login: 'jd-work' });
    work.userId = 2002;
    work.deviceSteps = ['pending', 'success'];
    server.use(work);
    await page.getByRole('tab', { name: 'Setup' }).click();
    await page.getByRole('button', { name: 'Connect another account' }).click();
    await expect(page.locator('.code')).toHaveText('WDJB-MJHT');
    await expect(page.getByText('Check the avatar at the top of that page')).toBeVisible();
    await expect(page.getByText(/Connected as @jd-work/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Connected as @jd2005l/)).toBeVisible();
    // The open page picks up its account without a reload, with only that account's repositories.
    await expect(rows(nav)).toHaveCount(12, { timeout: 20_000 });
    await expect(repoRow(nav, 301)).toHaveCount(1);
    await expect(repoRow(nav, 1)).toHaveCount(0);
    await github.screenshot({ path: join(SHOTS, 'second-account.png') });
    await github.close();

    // Switching back shows the first account's list again (its own cache, not the second's).
    device.login = 'jd2005l';
    github = await githubPage(device);
    nav = await openDrawer(github);
    await expect(rows(nav)).toHaveCount(255);
    await expect(repoRow(nav, 301)).toHaveCount(0);
    await github.close();

    // Options shows one account at a time; the picker switches between them.
    await page.getByLabel('GitHub account', { exact: true }).selectOption('jd-work');
    await page.getByRole('tab', { name: 'Repositories & sync' }).click();
    await expect(page.getByText('12', { exact: true })).toBeVisible();
    await page.getByLabel('GitHub account', { exact: true }).selectOption('jd2005l');
    await expect(page.getByText('255', { exact: true })).toBeVisible();
    await page.close();
  } finally {
    await close(device);
  }
});
