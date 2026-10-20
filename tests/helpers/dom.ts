import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, emptyLayout } from '../../src/shared/layout/model';
import type { Broadcast, NavState, Request, Response } from '../../src/shared/messages';
import type { AuthState, InstallationSummary, Layout, RepoRecord } from '../../src/shared/types';
import type { Transport } from '../../src/content/store';
import { makeRepos } from './repos';

const FIXTURE = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'github-drawer-2026-10.html'), 'utf8');

/** Replaces the test document with the github.com drawer fixture (drawer open, React build 2026-10). */
export function loadFixture(transform?: (doc: Document) => void): Document {
  const parsed = new DOMParser().parseFromString(FIXTURE, 'text/html');
  transform?.(parsed);
  const html = document.importNode(parsed.documentElement, true);
  document.replaceChild(html, document.documentElement);
  return document;
}

const SIDEBAR_FIXTURE = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'github-dashboard-sidebar-2026-10.html'), 'utf8');

/** Transform: adds the dashboard's left sidebar (github.com home page) to the page. */
export function withDashboardSidebar(doc: Document): void {
  const template = doc.createElement('template');
  template.innerHTML = SIDEBAR_FIXTURE;
  doc.body.prepend(template.content);
}

/** Transform: the drawer is closed (GitHub removes its portal content). */
export function withoutDrawer(doc: Document): void {
  doc.querySelector('#__primerPortalRoot__ [role="dialog"]')?.remove();
}

export function sidebarGroup(doc: Document = document): HTMLElement {
  return doc.querySelector<HTMLElement>('aside[aria-label="Dashboard menu"] li[data-component="ActionList.Group"]')!;
}

export function drawerDialog(doc: Document = document): HTMLElement {
  return doc.querySelector<HTMLElement>('#__primerPortalRoot__ [role="dialog"]')!;
}

export function topReposGroup(doc: Document = document): HTMLElement {
  const heading = [...doc.querySelectorAll('h3')].find((h) => h.querySelector('div')?.textContent === 'Top repositories')!;
  return heading.closest('li[data-component="ActionList.Group"]') as HTMLElement;
}

/** Variant: the 2026-05 build (different class hashes, fewer data-component hooks, no item test ids). */
export function as202605(doc: Document): void {
  const keep = new Set(['ActionList.Divider', 'NavList.GroupHeading', 'GroupHeadingWrap', 'Avatar', 'IconButton']);
  for (const el of doc.querySelectorAll('[data-component]')) if (!keep.has(el.getAttribute('data-component')!)) el.removeAttribute('data-component');
  for (const el of doc.querySelectorAll('[data-testid="dynamic-side-panel-items-item"]')) el.removeAttribute('data-testid');
  for (const el of doc.querySelectorAll('[class]')) el.setAttribute('class', el.getAttribute('class')!.replace(/-([A-Za-z0-9_-]{5})\b/g, '-x$1'));
  const label = doc.getElementById(drawerDialog(doc).getAttribute('aria-labelledby')!);
  if (label) label.textContent = 'Global Navigation Menu';
}

/** Variant: GitHub is still loading its list (spinner group instead of Top repositories). */
export function asLoading(doc: Document): void {
  const group = topReposGroup(doc);
  const spinner = doc.createElement('li');
  spinner.setAttribute('data-component', 'ActionList.Group');
  spinner.innerHTML = '<ul><li class="d-flex flex-justify-center"><span data-testid="dynamic-side-content-loader" role="status">Loading</span></li></ul>';
  group.replaceWith(spinner);
}

/** Variant: an extra "Teams" group after Top repositories that reuses the same test ids. */
export function withTeamsGroup(doc: Document): void {
  const group = topReposGroup(doc);
  const teams = group.cloneNode(true) as HTMLElement;
  teams.querySelector('h3 div')!.textContent = 'Teams';
  const tooltip = teams.querySelector('[popover]');
  if (tooltip) tooltip.textContent = 'Search for teams';
  for (const a of teams.querySelectorAll('a')) a.setAttribute('href', `/orgs/acme-corp/teams/${a.textContent.trim().split('/').pop() ?? 'x'}`);
  teams.setAttribute('data-test-teams', '');
  group.after(teams);
}

/** Variant: the drawer has a list of repository links but no recognisable heading or hooks. */
export function asUnknownMarkup(doc: Document): void {
  const group = topReposGroup(doc);
  group.querySelector('h3')!.remove();
  for (const el of group.querySelectorAll('[data-testid]')) el.removeAttribute('data-testid');
  for (const el of group.querySelectorAll('[data-component]')) el.removeAttribute('data-component');
  group.removeAttribute('data-component');
}

/** The legacy (<= 2025-09) server-rendered drawer with an inferred Top repositories fragment. */
export function legacyDrawerHtml(): string {
  return `
  <deferred-side-panel data-url="/_side-panels/global">
    <dialog open aria-modal="true" aria-labelledby="legacy-title" class="Overlay Overlay--placement-left" data-target="deferred-side-panel.panel">
      <h1 id="legacy-title" class="sr-only">Global navigation</h1>
      <nav aria-label="Site navigation"><ul>
        <li><a href="/dashboard">Home</a></li><li><a href="/issues">Issues</a></li><li><a href="/explore">Explore</a></li>
      </ul></nav>
      <div class="legacy-repos">
        <div class="d-flex"><h2 class="ActionList-sectionDivider-title">Top repositories</h2><button aria-label="Search for repositories">s</button></div>
        <ul>
          <li><a href="/octocat/Hello-World"><img class="avatar" alt="">octocat/Hello-World</a></li>
          <li><a href="/primer/react"><img class="avatar" alt="">primer/react</a></li>
        </ul>
        <button type="button">Show more</button>
      </div>
      <div class="px-2"><p>&copy; 2025 GitHub, Inc.</p><a href="https://github.com/about">About</a></div>
    </dialog>
  </deferred-side-panel>`;
}

export interface FakeBackend {
  transport: Transport;
  state: NavState;
  requests: Request[];
  broadcast(message: Broadcast): void;
  /** When set, layout/apply answers with this error. */
  rejectWith: string | null;
}

/** The account navState() belongs to (broadcasts for it carry this user ID). */
export const ACCOUNT_ID = 1001;

export function navState(options: { repos?: RepoRecord[]; layout?: Layout; auth?: AuthState; editable?: boolean; installations?: InstallationSummary[]; startChosen?: boolean } = {}): NavState {
  const repos = options.repos ?? makeRepos(225);
  // Signed out or signing in: no account is connected (the state of connecting the first one).
  const connected = !options.auth || options.auth.kind === 'signed-in' || options.auth.kind === 'expired';
  return {
    account: connected ? { userId: ACCOUNT_ID, login: 'jd2005l' } : null,
    accounts: connected ? ['jd2005l'] : [],
    pageLogin: 'jd2005l',
    auth: options.auth ?? { kind: 'signed-in', login: 'jd2005l', expiresAt: null },
    inventory: {
      repos,
      fetchedAt: Date.now() - 60_000,
      installations: options.installations ?? [{ id: 71, account: 'jd2005l', accountType: 'User', repositorySelection: 'all', settingsUrl: 'https://github.com/settings/installations/71', suspended: false }],
      status: { kind: 'idle' },
    },
    layout: {
      layout: options.layout ?? emptyLayout(),
      version: { epoch: 'e', seq: 1 },
      sync: options.editable === false ? { kind: 'readonly', reason: 'Saved by a newer version. Update the extension on this device to edit them.', writtenBySchema: 3 } : { kind: 'ok', bytes: 10, chunks: 1, lastWriteAt: null, pending: false },
      editable: options.editable ?? true,
    },
    onboarding: { startChosen: options.startChosen ?? true },
  };
}

/** A transport that behaves like the service worker: applies ops with the real model and acknowledges. */
export function fakeBackend(initial: NavState = navState()): FakeBackend {
  const listeners = new Set<(m: Broadcast) => void>();
  const backend: FakeBackend = {
    state: initial,
    requests: [],
    rejectWith: null,
    broadcast(message) {
      for (const l of listeners) l(message);
    },
    transport: {
      send(request: Request): Promise<Response> {
        backend.requests.push(request);
        if (request.type === 'nav/get') return Promise.resolve({ ok: true, data: structuredClone(backend.state) });
        if (request.type === 'layout/apply') {
          if (backend.rejectWith) return Promise.resolve({ ok: false, error: backend.rejectWith });
          const inventory = new Set(backend.state.inventory.repos.map((r) => r.id));
          const layout = applyOps(backend.state.layout.layout, request.ops, { inventory });
          backend.state = { ...backend.state, layout: { ...backend.state.layout, layout, version: { epoch: 'e', seq: backend.state.layout.version.seq + 1 } } };
          return Promise.resolve({ ok: true, data: structuredClone(backend.state.layout) });
        }
        return Promise.resolve({ ok: true, data: null });
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  return backend;
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
}
