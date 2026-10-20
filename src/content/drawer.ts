/**
 * Finds GitHub's global navigation drawer and its "Top repositories" section by scoring independent signals.
 *
 * GitHub's drawer (2025-10 onward) is a client-rendered Primer React Dialog portaled into
 * #__primerPortalRoot__ that exists only while open; hashed class names change between builds. So nothing here
 * depends on class names: roles, aria labelling, data-testid/data-component hooks, heading text and the shape
 * of links are combined, and anything short of a confident match means "leave GitHub alone" (fail open).
 * The legacy server-rendered drawer goes through the same scoring.
 */

export interface DrawerScore {
  score: number;
  signals: string[];
}

export interface SectionMatch {
  /** The element to hide: GitHub's whole Top repositories group. */
  container: HTMLElement;
  heading: HTMLElement | null;
  repoLinks: number;
  score: number;
  signals: string[];
}

const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** First path segments that are GitHub features, never repository owners. */
const RESERVED = new Set([
  'about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'copilot', 'customer-stories', 'dashboard', 'discussions',
  'enterprise', 'enterprises', 'events', 'explore', 'features', 'feed', 'gist', 'github-copilot', 'home', 'issues', 'join', 'login',
  'logout', 'marketplace', 'mcp', 'models', 'new', 'nonprofit', 'notifications', 'organizations', 'orgs', 'pricing', 'projects',
  'pulls', 'readme', 'repos', 'resources', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'solutions', 'spark',
  'sponsors', 'stars', 'team', 'teams', 'topics', 'trending', 'users', 'watching', 'writing',
]);
const OWNER_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,99})$/;
const NAME_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
/** Links that belong to the drawer's other groups; a container holding one of them is too big to hide. */
const FOREIGN_PATHS = new Set(['/dashboard', '/issues', '/pulls', '/repos', '/projects', '/discussions', '/codespaces', '/copilot', '/explore', '/marketplace', '/mcp', '/writing', '/spark', '/feed']);

function pathOf(anchor: Element, origin: string): string | null {
  const href = anchor.getAttribute('href');
  if (!href) return null;
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin) return null;
    return url.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

export function isRepoLink(anchor: Element, origin: string): boolean {
  const path = pathOf(anchor, origin);
  if (!path) return false;
  const parts = path.split('/').slice(1);
  if (parts.length !== 2) return false;
  const [owner, name] = parts as [string, string];
  return OWNER_SEGMENT.test(owner) && NAME_SEGMENT.test(name) && !RESERVED.has(owner.toLowerCase());
}

function isForeignNav(el: Element, origin: string): boolean {
  if (el.matches('[data-testid^="side-nav-menu-item-"]')) return true;
  if (el.tagName === 'A') {
    const path = pathOf(el, origin);
    return path !== null && FOREIGN_PATHS.has(path);
  }
  return false;
}

function containsForeignNav(el: Element, origin: string): boolean {
  if (isForeignNav(el, origin)) return true;
  for (const candidate of el.querySelectorAll('a[href], [data-testid^="side-nav-menu-item-"]')) if (isForeignNav(candidate, origin)) return true;
  return false;
}

/** Text of an element as a user reads it, resolving aria-labelledby (Primer moves labels into tooltips). */
function labelledText(el: Element): string {
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  if (ids.length) {
    const doc = el.ownerDocument;
    const text = ids.map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');
    if (normalize(text)) return normalize(text);
  }
  return normalize(el.getAttribute('aria-label') ?? el.textContent);
}

/** Heading text without its buttons, tooltips and icons ("Top repositoriesSearch for repositories" otherwise). */
export function headingText(heading: Element): string {
  const clone = heading.cloneNode(true) as Element;
  for (const noise of clone.querySelectorAll('button, [popover], [aria-hidden="true"], svg, .sr-only, [hidden]')) noise.remove();
  return normalize(clone.textContent);
}

export function candidateDialogs(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]')];
}

/**
 * The dashboard's left sidebar (github.com home page) has its own "Top repositories" list: a React partial
 * rendering a Primer NavList (`nav[data-testid="dashboard-repositories"]`, 2026-10) built from the same
 * ActionList group and `dynamic-side-panel-items-*` hooks as the drawer. `findTopRepositories` still has to
 * agree before anything is touched.
 *
 * Exactly one root per sidebar, and it must not change while the page lives: the server-rendered labelled
 * aside when there is one (it exists before React renders the list into it), otherwise the list's own nav.
 * Two overlapping roots would each remove the other's navigator and re-add their own, forever.
 */
export function candidateSidebars(root: ParentNode): HTMLElement[] {
  const asides = [...root.querySelectorAll<HTMLElement>('aside[aria-label="Dashboard menu"]')];
  const navs = [...root.querySelectorAll<HTMLElement>('nav[data-testid="dashboard-repositories"]')].filter((n) => !n.closest('[role="dialog"], dialog, aside[aria-label="Dashboard menu"]'));
  return [...asides, ...navs];
}

export function scoreDrawer(dialog: HTMLElement): DrawerScore {
  const origin = dialog.ownerDocument.location?.origin ?? 'https://github.com';
  const signals: string[] = [];
  let score = 0;
  const modal = (dialog.getAttribute('role') === 'dialog' && dialog.getAttribute('aria-modal') === 'true') || (dialog.tagName === 'DIALOG' && dialog.hasAttribute('open'));
  if (modal && /global nav(igation)?( menu)?/.test(labelledText(dialog))) {
    score += 2;
    signals.push('D1:label');
  }
  if (dialog.getAttribute('data-position-regular') === 'left' || dialog.closest('[data-position-regular="left"]') || /placement-left/.test(dialog.className)) {
    score += 1;
    signals.push('D2:left');
  }
  const home = [...dialog.querySelectorAll('a[href]')].some((a) => pathOf(a, origin) === '/dashboard') || !!dialog.querySelector('[data-testid^="side-nav-menu-item-"]');
  if (home) {
    score += 1;
    signals.push('D3:nav');
  }
  if (dialog.closest('#__primerPortalRoot__') || dialog.matches('[data-target="deferred-side-panel.panel"]') || dialog.closest('deferred-side-panel')) {
    score += 1;
    signals.push('D4:portal');
  }
  return { score, signals };
}

export function isGlobalDrawer(dialog: HTMLElement): boolean {
  return scoreDrawer(dialog).score >= 3;
}

const ITEM_TESTIDS = ['dynamic-side-panel-items-search-button', 'dynamic-side-panel-items-close-search-button', 'dynamic-side-panel-items-show-more', 'dynamic-side-panel-items-item'];

/**
 * Locates the Top repositories group inside a confirmed drawer. Returns null (do nothing) unless the heading
 * text or the repository-search hooks agree with repository-shaped links.
 */
export function findTopRepositories(dialog: HTMLElement): SectionMatch | null {
  const origin = dialog.ownerDocument.location?.origin ?? 'https://github.com';
  const heading =
    [...dialog.querySelectorAll<HTMLElement>('h2, h3, h4, h5, [role="heading"]')].find((h) => headingText(h) === 'top repositories') ?? null;

  // The search toggle is shared with other groups (e.g. "Teams"), so it only counts when it searches repositories.
  // In search mode the toggle becomes "Close search" and an input appears; both carry the repository wording.
  const searchButton = [
    ...dialog.querySelectorAll<HTMLElement>(
      '[data-testid="dynamic-side-panel-items-search-button"], [data-testid="dynamic-side-panel-items-close-search-button"], [data-testid="dynamic-side-panel-items-search-input"]',
    ),
  ].find((b) => /repositor/.test(labelledText(b)) || /repositor/i.test(b.getAttribute('placeholder') ?? ''));

  let container: HTMLElement | null = null;
  const start = heading ?? searchButton ?? null;
  if (start) {
    container = start.closest<HTMLElement>('li[data-component="ActionList.Group"]');
    if (container && !dialog.contains(container)) container = null;
    if (!container) {
      // Class-agnostic fallback: the largest ancestor that holds this section but nothing from the other groups.
      let node: HTMLElement | null = start.parentElement;
      while (node && node !== dialog) {
        if (containsForeignNav(node, origin)) break;
        const otherHeading = [...node.querySelectorAll('h2, h3, h4, h5, [role="heading"]')].some((h) => h !== heading && !h.contains(start) && headingText(h) !== 'top repositories' && headingText(h) !== '');
        if (otherHeading) break;
        container = node;
        node = node.parentElement;
      }
    }
  }
  if (!container || containsForeignNav(container, origin)) return null;

  const signals: string[] = [];
  let score = 0;
  if (heading && container.contains(heading)) {
    score += 2;
    signals.push('S1:heading');
  }
  if (searchButton && container.contains(searchButton)) {
    score += 2;
    signals.push('S2:search-hook');
  } else if (ITEM_TESTIDS.some((id) => container.querySelector(`[data-testid="${id}"]`)) && heading) {
    signals.push('S2:item-hooks');
  }
  const repoLinks = [...container.querySelectorAll('a[href]')].filter((a) => isRepoLink(a, origin)).length;
  if (repoLinks > 0) {
    score += 1;
    signals.push('S3:repo-links');
  }
  const showMore =
    !!container.querySelector('[data-testid="dynamic-side-panel-items-show-more"]') ||
    [...container.querySelectorAll('button, a, [role="button"]')].some((b) => /^show (even )?more$/.test(normalize(b.textContent)));
  if (showMore) {
    score += 1;
    signals.push('S4:show-more');
  }
  const hasHeading = signals.includes('S1:heading');
  const hasHook = signals.includes('S2:search-hook');
  const hasLinks = repoLinks > 0;
  const accepted = (hasHeading && (hasHook || hasLinks)) || (hasHook && hasLinks);
  if (!accepted) return null;
  return { container, heading, repoLinks, score, signals };
}

/**
 * While GitHub loads its list, the Top repositories slot is a group holding only its spinner. Treating that group
 * as the slot lets the navigator replace it straight away (no flash of GitHub's list), including when GitHub's own
 * fetch fails and the spinner would otherwise stay forever. Never matches anything holding other navigation.
 */
export function findLoadingSlot(dialog: HTMLElement): SectionMatch | null {
  const origin = dialog.ownerDocument.location?.origin ?? 'https://github.com';
  const loader = dialog.querySelector<HTMLElement>('[data-testid="dynamic-side-content-loader"]');
  if (!loader) return null;
  const container = loader.closest<HTMLElement>('li[data-component="ActionList.Group"]');
  if (!container || !dialog.contains(container) || containsForeignNav(container, origin)) return null;
  if (container.querySelector('a[href]')) return null;
  return { container, heading: null, repoLinks: 0, score: 1, signals: ['L:loader'] };
}

/** The drawer's close button (Primer names it through a tooltip), for closing the drawer after navigation. */
export function findCloseButton(dialog: HTMLElement): HTMLElement | null {
  return [...dialog.querySelectorAll<HTMLElement>('button')].find((b) => /^close( menu| navigation)?$/.test(labelledText(b))) ?? null;
}
