// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContentStore } from '../../src/content/store';
import { NavigatorView, displayMode } from '../../src/content/ui/navigator';
import { UNCATEGORIZED_ID, applyOps, emptyLayout, type LayoutOp } from '../../src/shared/layout/model';
import type { Layout } from '../../src/shared/types';
import { ACCOUNT_ID, fakeBackend, flush, navState, type FakeBackend } from '../helpers/dom';
import { apiRepo, makeRepos } from '../helpers/repos';

let view: NavigatorView | null = null;
let host: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => view?.destroy());

function layoutWith(ops: LayoutOp[], inventory: number[]): Layout {
  return applyOps(emptyLayout(), ops, { inventory: new Set(inventory) });
}

async function mount(state = navState()) {
  const backend = fakeBackend(state);
  const store = new ContentStore(backend.transport);
  await store.load();
  view = new NavigatorView(host, store, { now: () => Date.now() });
  await flush();
  return { backend, store, view, root: host.shadowRoot! };
}

const appliedOps = (backend: FakeBackend) => backend.requests.filter((r) => r.type === 'layout/apply').flatMap((r) => (r as { ops: LayoutOp[] }).ops);
const repoLinks = (root: ShadowRoot) => [...root.querySelectorAll<HTMLAnchorElement>('[data-repo-link]')].filter((a) => !a.closest('[hidden]'));
const key = (target: Element, k: string, extra: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true, ...extra }));
const sectionNames = (root: ShadowRoot) => [...root.querySelectorAll('.grn-section-name')].map((n) => n.textContent);

describe('NavigatorView', () => {
  it('renders the complete inventory, including repositories beyond the first two API pages', async () => {
    const { root } = await mount();
    const links = repoLinks(root);
    expect(links).toHaveLength(225);
    const texts = links.map((a) => a.querySelector('.grn-repo-text')!.textContent);
    for (const n of [1, 101, 201, 225]) expect(texts).toContain(`${apiRepo(n).owner.login}/${apiRepo(n).name}`);
    expect(root.querySelector('.grn-title-count')!.textContent).toBe('225');
    expect(root.querySelector('.grn-footer')!.textContent).toMatch(/225 repositories/);
    expect(links[0]!.getAttribute('href')).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  });

  it('filters the whole cached inventory as you type, and Escape clears without closing the drawer', async () => {
    const { root } = await mount();
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    const target = apiRepo(213);
    input.value = `${target.owner.login} ${target.name}`;
    input.dispatchEvent(new Event('input'));
    await flush();
    expect(repoLinks(root).map((a) => a.querySelector('.grn-repo-text')!.textContent)).toEqual([`${target.owner.login}/${target.name}`]);
    expect(root.querySelectorAll('mark').length).toBeGreaterThan(0);
    expect(root.querySelector('.grn-footer')!.textContent).toMatch(/1 of 225 match/);
    input.focus();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true });
    input.dispatchEvent(escape);
    await flush();
    expect(escape.defaultPrevented).toBe(true); // Primer's dialog ignores prevented Escape presses
    expect(repoLinks(root)).toHaveLength(225);
  });

  it('keeps typed keys away from GitHub\u2019s page shortcuts', async () => {
    const { root } = await mount();
    const seen: string[] = [];
    const onDoc = (e: Event) => seen.push((e as KeyboardEvent).key);
    document.addEventListener('keydown', onDoc);
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    for (const k of ['s', '/', '.', '?', 'Escape']) input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true }));
    document.removeEventListener('keydown', onDoc);
    expect(seen).toEqual(['Escape']); // empty filter: Escape may still close the drawer
  });

  it('creates a section from the header and places it before Uncategorized', async () => {
    const { root, backend } = await mount();
    root.querySelector<HTMLButtonElement>('button[aria-label="New section"]')!.click();
    await flush();
    const input = root.querySelector<HTMLInputElement>('input[aria-label="New section name"]')!;
    input.value = 'Client work';
    key(input, 'Enter');
    await flush();
    const op = appliedOps(backend)[0]!;
    expect(op).toMatchObject({ type: 'createSection', name: 'Client work', beforeSectionId: UNCATEGORIZED_ID });
    expect(sectionNames(root)).toEqual(['Client work', 'Uncategorized']);
  });

  it('renames, collapses and expands sections', async () => {
    const ids = makeRepos(225).map((r) => r.id);
    const layout = layoutWith([{ type: 'createSection', sectionId: 'work', name: 'Work', beforeSectionId: UNCATEGORIZED_ID }, { type: 'moveRepo', repoId: ids[0]!, toSectionId: 'work', beforeRepoId: null }], ids);
    const { root, backend } = await mount(navState({ layout }));
    root.querySelector<HTMLButtonElement>('[data-menu-anchor="section:work"]')!.click();
    await flush();
    const rename = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent.includes('Rename'))!;
    rename.click();
    await flush();
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Section name"]')!;
    input.value = 'Day job';
    key(input, 'Enter');
    await flush();
    expect(sectionNames(root)[0]).toBe('Day job');

    const toggle = root.querySelector<HTMLButtonElement>('[data-section-toggle="work"]')!;
    toggle.click();
    await flush();
    expect(root.querySelector('[data-section-toggle="work"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector<HTMLElement>('#grn-list-work')!.hidden).toBe(true);
    key(root.querySelector('[data-section-toggle="work"]')!, 'ArrowRight');
    await flush();
    expect(root.querySelector('[data-section-toggle="work"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(appliedOps(backend).map((o) => o.type)).toEqual(['renameSection', 'setCollapsed', 'setCollapsed']);
  });

  it('explains why a non-empty section cannot be deleted and deletes empty ones', async () => {
    const ids = makeRepos(225).map((r) => r.id);
    const layout = layoutWith(
      [
        { type: 'createSection', sectionId: 'full', name: 'Full', beforeSectionId: UNCATEGORIZED_ID },
        { type: 'createSection', sectionId: 'empty', name: 'Empty', beforeSectionId: UNCATEGORIZED_ID },
        { type: 'moveRepo', repoId: ids[0]!, toSectionId: 'full', beforeRepoId: null },
        { type: 'moveRepo', repoId: ids[1]!, toSectionId: 'full', beforeRepoId: null },
      ],
      ids,
    );
    const { root, backend } = await mount(navState({ layout }));
    root.querySelector<HTMLButtonElement>('[data-menu-anchor="section:full"]')!.click();
    await flush();
    const del = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent.includes('Delete section'))!;
    expect(del.getAttribute('aria-disabled')).toBe('true');
    expect(del.textContent).toContain('Only empty sections can be deleted. Move its 2 repositories to another section first.');
    del.click();
    await flush();
    expect(appliedOps(backend)).toHaveLength(0);
    // Delete key on the section header gives the same explanation.
    key(root.querySelector('[data-section-toggle="full"]')!, 'Delete');
    await flush();
    expect(root.querySelector('.grn-banner')!.textContent).toContain('Only empty sections can be deleted');

    root.querySelector<HTMLButtonElement>('[data-menu-anchor="section:empty"]')!.click();
    await flush();
    [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent.includes('Delete section'))!.click();
    await flush();
    expect(appliedOps(backend)).toEqual([{ type: 'deleteSection', sectionId: 'empty' }]);
    expect(sectionNames(root)).toEqual(['Full', 'Uncategorized']);
  });

  it('moves repositories with Alt+Arrow keys, across section edges, keeping focus and announcing', async () => {
    const repos = makeRepos(225);
    const ids = repos.map((r) => r.id);
    const layout = layoutWith(
      [
        { type: 'createSection', sectionId: 'a', name: 'Alpha', beforeSectionId: UNCATEGORIZED_ID },
        { type: 'createSection', sectionId: 'b', name: 'Beta', beforeSectionId: UNCATEGORIZED_ID },
        ...[0, 1, 2].map((i) => ({ type: 'moveRepo' as const, repoId: ids[i]!, toSectionId: 'a', beforeRepoId: null })),
        { type: 'moveRepo', repoId: ids[3]!, toSectionId: 'b', beforeRepoId: null },
      ],
      ids,
    );
    const { root, backend } = await mount(navState({ layout }));
    const link = (id: number) => root.querySelector<HTMLAnchorElement>(`[data-repo-link="${id}"]`)!;
    link(ids[0]!).focus();
    key(link(ids[0]!), 'ArrowDown', { altKey: true });
    await flush();
    expect(appliedOps(backend)[0]).toEqual({ type: 'moveRepo', repoId: ids[0], toSectionId: 'a', beforeRepoId: ids[2] });
    expect(root.activeElement).toBe(link(ids[0]!));
    // Now last in Alpha: Alt+Down moves it to the top of Beta.
    key(link(ids[0]!), 'ArrowDown', { altKey: true });
    await flush();
    key(link(ids[0]!), 'ArrowDown', { altKey: true });
    await flush();
    expect(appliedOps(backend).at(-1)).toEqual({ type: 'moveRepo', repoId: ids[0], toSectionId: 'b', beforeRepoId: ids[3] });
    expect(root.activeElement).toBe(link(ids[0]!));
    await new Promise((r) => requestAnimationFrame(r));
    expect(root.querySelector('[aria-live]')!.textContent).toMatch(/Moved .* to Beta, position 1 of 2\./);
    // Plain arrows move focus between rows and section headers.
    key(link(ids[0]!), 'ArrowUp');
    expect(root.activeElement).toBe(root.querySelector('[data-section-toggle="b"]'));
  });

  it('reorders sections from the keyboard', async () => {
    const layout = layoutWith([{ type: 'createSection', sectionId: 'a', name: 'Alpha', beforeSectionId: UNCATEGORIZED_ID }, { type: 'createSection', sectionId: 'b', name: 'Beta', beforeSectionId: UNCATEGORIZED_ID }], []);
    const { root } = await mount(navState({ layout }));
    const toggle = root.querySelector<HTMLButtonElement>('[data-section-toggle="b"]')!;
    toggle.focus();
    key(toggle, 'ArrowUp', { altKey: true });
    await flush();
    expect(sectionNames(root)).toEqual(['Beta', 'Alpha', 'Uncategorized']);
    expect(root.activeElement).toBe(root.querySelector('[data-section-toggle="b"]'));
  });

  it('moves a repository to another section or a new one from its menu', async () => {
    const ids = makeRepos(225).map((r) => r.id);
    const layout = layoutWith([{ type: 'createSection', sectionId: 'a', name: 'Alpha', beforeSectionId: UNCATEGORIZED_ID }], ids);
    const { root, backend } = await mount(navState({ layout }));
    const target = ids[10]!;
    root.querySelector<HTMLButtonElement>(`[data-menu-anchor="repo:${target}"]`)!.click();
    await flush();
    const items = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.find((b) => b.textContent.includes('Uncategorized'))!.getAttribute('aria-disabled')).toBe('true');
    items.find((b) => b.textContent.includes('Alpha'))!.click();
    await flush();
    expect(appliedOps(backend)[0]).toEqual({ type: 'moveRepo', repoId: target, toSectionId: 'a', beforeRepoId: null });

    root.querySelector<HTMLButtonElement>(`[data-menu-anchor="repo:${ids[11]}"]`)!.click();
    await flush();
    [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent.includes('New section'))!.click();
    await flush();
    const input = root.querySelector<HTMLInputElement>('input[aria-label="New section name"]')!;
    input.value = 'Fresh';
    key(input, 'Enter');
    await flush();
    const [create, move] = appliedOps(backend).slice(1);
    expect(create).toMatchObject({ type: 'createSection', name: 'Fresh' });
    expect(move).toMatchObject({ type: 'moveRepo', repoId: ids[11], toSectionId: (create as { sectionId: string }).sectionId });
  });

  it('closes menus with Escape (without letting it close the drawer) and returns focus', async () => {
    const { root } = await mount();
    const anchor = root.querySelector<HTMLButtonElement>('[data-menu-anchor^="repo:"]')!;
    anchor.click();
    await flush();
    const item = root.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(root.activeElement).toBe(item);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true });
    item.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(root.activeElement).toBe(anchor);
  });

  it('keeps keyboard focus inside an open menu when a background update re-renders', async () => {
    const { root, backend } = await mount();
    root.querySelector<HTMLButtonElement>('[data-menu-anchor^="repo:"]')!.click();
    await flush();
    const second = root.querySelectorAll<HTMLElement>('[role="menuitem"]')[1]!;
    second.focus();
    const label = second.textContent;
    backend.broadcast({ type: 'nav/inventory', account: ACCOUNT_ID, inventory: { ...backend.state.inventory, fetchedAt: Date.now() } });
    await flush();
    expect(root.querySelector('[role="menu"]')).toBeTruthy();
    expect((root.activeElement as HTMLElement | null)?.textContent).toBe(label);
  });

  it('ignores a drop where the repository already is (drag back to cancel)', async () => {
    const ids = makeRepos(225).map((r) => r.id);
    const layout = layoutWith(
      [{ type: 'createSection', sectionId: 'w', name: 'Work', beforeSectionId: UNCATEGORIZED_ID }, ...[0, 1, 2, 3].map((i) => ({ type: 'moveRepo' as const, repoId: ids[i]!, toSectionId: 'w', beforeRepoId: null }))],
      ids,
    );
    const { backend } = await mount(navState({ layout }));
    const drop = (view as unknown as { dropRepo(id: number, t: { sectionId: string; beforeRepoId: number | null; indicator: unknown }): void }).dropRepo.bind(view);
    drop(ids[1]!, { sectionId: 'w', beforeRepoId: ids[1]!, indicator: { kind: 'line', y: 0 } }); // upper half of its own row
    drop(ids[1]!, { sectionId: 'w', beforeRepoId: ids[2]!, indicator: { kind: 'line', y: 0 } }); // lower half of its own row
    drop(ids[3]!, { sectionId: 'w', beforeRepoId: null, indicator: { kind: 'line', y: 0 } }); // last stays last
    await flush();
    expect(appliedOps(backend)).toHaveLength(0);
    drop(ids[1]!, { sectionId: 'w', beforeRepoId: null, indicator: { kind: 'line', y: 0 } });
    await flush();
    expect(appliedOps(backend)).toEqual([{ type: 'moveRepo', repoId: ids[1], toSectionId: 'w', beforeRepoId: null }]);
  });

  it('keeps a half-typed section name and focus through background updates', async () => {
    const layout = layoutWith([{ type: 'createSection', sectionId: 'w', name: 'Work', beforeSectionId: UNCATEGORIZED_ID }], []);
    const { root, backend } = await mount(navState({ layout }));
    root.querySelector<HTMLButtonElement>('[data-menu-anchor="section:w"]')!.click();
    await flush();
    [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent.includes('Rename'))!.click();
    await flush();
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Section name"]')!;
    input.value = 'Half-typ';
    backend.broadcast({ type: 'nav/inventory', account: ACCOUNT_ID, inventory: { ...backend.state.inventory, fetchedAt: Date.now() } });
    backend.broadcast({ type: 'nav/layout', account: ACCOUNT_ID, layout: { ...backend.state.layout, version: { epoch: 'e', seq: 99 } } });
    await flush();
    expect(root.querySelector('input[aria-label="Section name"]')).toBe(input);
    expect(input.value).toBe('Half-typ');
    expect(root.activeElement).toBe(input);
    key(input, 'Enter');
    await flush();
    expect(appliedOps(backend)).toEqual([{ type: 'renameSection', sectionId: 'w', name: 'Half-typ' }]);
  });

  it('keeps focus usable after collapsing from the menu and after moving into a collapsed section', async () => {
    const ids = makeRepos(225).map((r) => r.id);
    const layout = layoutWith(
      [
        { type: 'createSection', sectionId: 'a', name: 'Alpha', beforeSectionId: UNCATEGORIZED_ID },
        { type: 'createSection', sectionId: 'b', name: 'Beta', beforeSectionId: UNCATEGORIZED_ID },
        { type: 'moveRepo', repoId: ids[0]!, toSectionId: 'a', beforeRepoId: null },
        { type: 'moveRepo', repoId: ids[1]!, toSectionId: 'b', beforeRepoId: null },
        { type: 'setCollapsed', sectionId: 'b', collapsed: true },
      ],
      ids,
    );
    const { root } = await mount(navState({ layout }));
    root.querySelector<HTMLButtonElement>('[data-menu-anchor="section:a"]')!.click();
    await flush();
    [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent.includes('Collapse'))!.click();
    await flush();
    expect(root.activeElement).toBe(root.querySelector('[data-menu-anchor="section:a"]'));
    // Expand Alpha again and move its repository down into collapsed Beta.
    key(root.querySelector('[data-section-toggle="a"]')!, 'ArrowRight');
    await flush();
    const link = root.querySelector<HTMLAnchorElement>(`[data-repo-link="${ids[0]}"]`)!;
    link.focus();
    key(link, 'ArrowDown', { altKey: true });
    await flush();
    expect(root.activeElement).toBe(root.querySelector('[data-section-toggle="b"]'));
  });

  it('moves from the filter to the first visible row even when the first section is collapsed', async () => {
    const layout = layoutWith([{ type: 'createSection', sectionId: 'a', name: 'Alpha', beforeSectionId: UNCATEGORIZED_ID }, { type: 'setCollapsed', sectionId: 'a', collapsed: true }], []);
    const { root } = await mount(navState({ layout }));
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.focus();
    key(input, 'ArrowDown');
    expect(root.activeElement).toBe(root.querySelector('[data-section-toggle="a"]'));
  });

  it('highlights matches that span owner and name', async () => {
    const { root } = await mount();
    const target = apiRepo(213);
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = `${target.owner.login.slice(-2)}/${target.name.slice(0, 3)}`;
    input.dispatchEvent(new Event('input'));
    await flush();
    const marks = [...root.querySelectorAll(`[data-repo-link="${target.id}"] mark`)].map((m) => m.textContent).join('');
    expect(marks).toBe(input.value);
  });

  it('asks once on first run whether to suggest sections or start with one list', async () => {
    const { root, backend } = await mount(navState({ startChosen: false }));
    const start = root.querySelector('.grn-start')!;
    expect(start.textContent).toContain('How do you want to start?');
    expect(start.textContent).toContain('225 repositories');
    const button = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('.grn-start button')].find((b) => b.textContent === name)!;
    button('Suggest sections').click();
    await flush();
    expect(backend.requests).toContainEqual({ type: 'options/open', tab: 'organize', suggest: true });
    button('Start with one list').click();
    await flush();
    expect(backend.requests).toContainEqual({ type: 'onboarding/start-empty' });
    backend.broadcast({ type: 'nav/onboarding', account: ACCOUNT_ID, onboarding: { startChosen: true } });
    await flush();
    expect(root.querySelector('.grn-start')).toBeNull();
    expect(repoLinks(root)).toHaveLength(225);
  });

  it('does not ask how to start once sections exist', async () => {
    const layout = layoutWith([{ type: 'createSection', sectionId: 'work', name: 'Work', beforeSectionId: null }], []);
    const { root } = await mount(navState({ startChosen: false, layout }));
    expect(root.querySelector('.grn-start')).toBeNull();
  });

  it('warns in the menu when the app is not installed, and sends the user to setup', async () => {
    const { root, backend } = await mount(navState({ repos: makeRepos(9), installations: [] }));
    const banner = root.querySelector('.grn-banner')!;
    expect(banner.textContent).toContain('Only public repositories are showing');
    [...banner.querySelectorAll('button')].find((b) => b.textContent === 'Finish setup')!.click();
    await flush();
    expect(backend.requests.some((r) => r.type === 'options/open')).toBe(true);
  });

  it('warns in the menu when an installation only shares selected repositories', async () => {
    const { root } = await mount(
      navState({ installations: [{ id: 71, account: 'jd2005l', accountType: 'User', repositorySelection: 'selected', settingsUrl: null, suspended: false }] }),
    );
    expect(root.querySelector('.grn-banner')!.textContent).toContain('only share selected repositories');
  });

  it('shows no setup warning once the app sees all repositories', async () => {
    const { root } = await mount();
    expect(root.querySelector('.grn-banner')).toBeNull();
  });

  it('shows a read-only layout without edit affordances', async () => {
    const { root, backend } = await mount(navState({ editable: false }));
    expect(root.querySelector('.grn-banner')!.textContent).toContain('newer version');
    expect(root.querySelector('[data-drag-repo]')).toBeNull();
    expect(root.querySelector('.grn-row-menu')).toBeNull();
    key(repoLinks(root)[0]!, 'ArrowDown', { altKey: true });
    await flush();
    expect(appliedOps(backend)).toHaveLength(0);
  });

  it('renders names only as text', async () => {
    const layout = layoutWith([{ type: 'createSection', sectionId: 'x', name: '<img src=x onerror=alert(1)><b>bold</b>', beforeSectionId: UNCATEGORIZED_ID }], []);
    const { root } = await mount(navState({ layout }));
    expect(root.querySelector('img[src="x"]')).toBeNull();
    expect(root.querySelector('b')).toBeNull();
    expect(root.querySelector('.grn-section-name')!.textContent).toBe('<img src=x onerror=alert(1)><b>bold</b>');
  });

  it('shows cached repositories with a banner when authorization expired, rate limited or offline', async () => {
    let state = navState({ auth: { kind: 'expired', login: 'jd2005l' } });
    expect(displayMode(state)).toBe('replace');
    let { root } = await mount(state);
    expect(root.querySelector('.grn-banner')!.textContent).toContain('authorization expired');
    expect(repoLinks(root)).toHaveLength(225);
    view!.destroy();

    state = navState();
    state.inventory.status = { kind: 'rate-limited', resetAt: Date.now() + 600_000 };
    host.replaceWith((host = document.createElement('div')));
    ({ root } = await mount(state));
    expect(root.querySelector('.grn-banner')!.textContent).toMatch(/rate limit/);
    view!.destroy();

    state = navState();
    state.inventory.status = { kind: 'offline' };
    host.replaceWith((host = document.createElement('div')));
    ({ root } = await mount(state));
    expect(root.querySelector('.grn-banner')!.textContent).toMatch(/unreachable/);
  });

  it('shows a prompt (GitHub list stays) for signed-out, setup and authorizing states', async () => {
    let { root } = await mount(navState({ auth: { kind: 'signed-out', clientIdConfigured: false, problem: null }, repos: [] }));
    expect(root.textContent).toContain('needs setup');
    expect(root.querySelector<HTMLElement>('.grn-search')!.hidden).toBe(true);
    view!.destroy();
    host.replaceWith((host = document.createElement('div')));
    ({ root } = await mount(navState({ auth: { kind: 'authorizing', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 1000 }, repos: [] })));
    expect(root.textContent).toContain('WDJB-MJHT');
    expect(displayMode(navState({ repos: [] }))).toBe('prompt');
  });

  it('applies edits optimistically and reports a rejection', async () => {
    const { root, backend } = await mount();
    backend.rejectWith = 'Chrome Sync is unavailable.';
    root.querySelector<HTMLButtonElement>('button[aria-label="New section"]')!.click();
    await flush();
    const input = root.querySelector<HTMLInputElement>('input[aria-label="New section name"]')!;
    input.value = 'Temp';
    key(input, 'Enter');
    await flush();
    expect(sectionNames(root)).toEqual(['Uncategorized']);
    expect(root.querySelector('.grn-banner')!.textContent).toContain('Chrome Sync is unavailable.');
  });
});
