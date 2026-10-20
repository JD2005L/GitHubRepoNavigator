import { candidateDialogs, candidateSidebars, findCloseButton, findLoadingSlot, findTopRepositories, isGlobalDrawer } from './drawer';
import type { ContentStore } from './store';
import { NavigatorView, type DisplayMode } from './ui/navigator';

export const HIDDEN_ATTR = 'data-grn-hidden';
export const HOST_ATTR = 'data-grn-host';
const DOC_STYLE_ID = 'grn-doc-css';
/**
 * Asked of a navigator host found in GitHub's page that is not ours. Every live copy of the extension (a store
 * install next to an unpacked build, or the new script after an update) answers for its own hosts by cancelling
 * the event; a host nobody answers for was left behind by a script that is gone. Content scripts run in separate
 * isolated worlds, but they share the DOM, so an event's cancellation is visible across them.
 */
const ALIVE_EVENT = 'grn-host-alive';
const WATCHDOG_MS = 1500;
/** Where GitHub's drawer (React portal, or the legacy server-rendered panel) and the dashboard sidebar live. */
const DRAWER_ZONE =
  '#__primerPortalRoot__, [role="dialog"], dialog, deferred-side-panel, react-partial[partial-name="dashboard-repositories"], nav[data-testid="dashboard-repositories"], aside[aria-label="Dashboard menu"]';

interface Mount {
  /** The open drawer dialog, or the dashboard sidebar's repository list. */
  dialog: HTMLElement;
  kind: 'drawer' | 'sidebar';
  observer: MutationObserver;
  host: HTMLElement | null;
  /** Element carrying the shadow root (the host itself, or a <div> inside an <li> host). */
  shadowHost: HTMLElement | null;
  view: NavigatorView | null;
  container: HTMLElement | null;
  mode: DisplayMode;
  watchdog: ReturnType<typeof setTimeout> | null;
  /** Set after a failure: this drawer instance keeps GitHub's own list. */
  failed: boolean;
  /** Another live copy of the extension already has a navigator here: stay out of its way. */
  yielded: boolean;
}

export interface MounterOptions {
  /** Called when a drawer opens, so the store can refresh. */
  onDrawerOpen?: () => void;
  log?: (message: string, error?: unknown) => void;
  /** False once the extension was reloaded/updated under this page: the orphaned script must step aside. */
  isAlive?: () => boolean;
}

/** Whether the document has a layout engine (real browser) as opposed to a DOM-only test environment. */
function hasLayout(doc: Document): boolean {
  return doc.documentElement.getBoundingClientRect().height > 0;
}

/** Whether a live copy of the extension (this one or another) still owns this navigator host. */
function answersAlive(host: HTMLElement): boolean {
  return !host.dispatchEvent(new Event(ALIVE_EVENT, { cancelable: true }));
}

export function resolveTheme(doc: Document): 'light' | 'dark' {
  const mode = doc.documentElement.getAttribute('data-color-mode');
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  const view = doc.defaultView;
  return view?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Keeps exactly one navigator next to GitHub's Top repositories group in every open global drawer and in the
 * dashboard's left sidebar.
 *
 * - Only our own marker attribute is ever set on GitHub's nodes; nothing GitHub owns is moved or removed.
 * - GitHub's group is hidden only after our view has rendered real content (two-phase reveal), and is shown
 *   again if our view fails, disappears or turns out invisible (fail open).
 * - Re-renders (loading → data, search toggles, "Show more", Turbo/soft navigation) are handled by a
 *   per-drawer observer that re-applies the marker and moves our host back next to the group.
 */
export class DrawerMounter {
  private readonly mounts = new Map<HTMLElement, Mount>();
  /** Dialogs already scored as "not the drawer" (other GitHub dialogs), so busy pages do not rescore them. */
  private notDrawers = new WeakSet<HTMLElement>();
  private observer: MutationObserver | null = null;
  private scanQueued = false;
  /** Measured once: a real browser always has layout; a DOM-only test environment never does. */
  private layout = false;
  private readonly onNavigation = () => this.queueScan();

  constructor(
    private readonly doc: Document,
    private readonly store: ContentStore,
    private readonly options: MounterOptions = {},
  ) {}

  start(): void {
    this.ensureDocStyle();
    this.layout = hasLayout(this.doc);
    // Cheap filter: only mutations in or around the drawer's zone schedule a scan, so busy pages (streaming logs,
    // large diffs, hovercards) cost a closest() per record and nothing else.
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        if (this.relevant(record)) {
          this.queueScan();
          return;
        }
      }
    });
    this.observer.observe(this.doc.documentElement, { childList: true, subtree: true });
    for (const type of ['turbo:load', 'turbo:render', 'soft-nav:end', 'soft-nav:success']) this.doc.addEventListener(type, this.onNavigation);
    this.scan();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const type of ['turbo:load', 'turbo:render', 'soft-nav:end', 'soft-nav:success']) this.doc.removeEventListener(type, this.onNavigation);
    for (const mount of [...this.mounts.values()]) this.teardown(mount);
  }

  private ensureDocStyle(): void {
    if (this.doc.getElementById(DOC_STYLE_ID)) return;
    const style = this.doc.createElement('style');
    style.id = DOC_STYLE_ID;
    // The only page-level CSS the extension adds, and it only targets our own marker.
    style.textContent = `[${HIDDEN_ATTR}]{display:none!important}`;
    (this.doc.head ?? this.doc.documentElement).appendChild(style);
  }

  private relevant(record: MutationRecord): boolean {
    if (!record.addedNodes.length && !record.removedNodes.length) return false;
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (target?.closest(DRAWER_ZONE)) return true;
    for (const node of record.removedNodes) if (node instanceof Element && (this.mounts.has(node as HTMLElement) || [...this.mounts.keys()].some((d) => node.contains(d)))) return true;
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      // Added subtrees are checked only when they are shallow page-structure insertions (Turbo body swaps,
      // portals, dialogs), never per streamed log line or diff hunk.
      if (node.matches(DRAWER_ZONE) || (node.parentElement === this.doc.body || node === this.doc.body || node.parentElement?.hasAttribute('data-turbo-body') ? !!node.querySelector(DRAWER_ZONE) : false)) return true;
    }
    return false;
  }

  private queueScan(): void {
    if (this.scanQueued) return;
    this.scanQueued = true;
    const run = () => {
      this.scanQueued = false;
      this.scan();
    };
    if (typeof requestAnimationFrame === 'function' && this.layout) requestAnimationFrame(run);
    else queueMicrotask(run);
  }

  /** Finds open drawers, mounts into new ones, and cleans up closed ones. Safe to call any number of times. */
  scan(): void {
    if (this.options.isAlive && !this.options.isAlive()) {
      this.stop(); // gives GitHub's list back everywhere
      return;
    }
    try {
      this.ensureDocStyle();
      for (const [dialog, mount] of this.mounts) if (!dialog.isConnected) this.teardown(mount);
      for (const dialog of candidateDialogs(this.doc)) {
        if (this.mounts.has(dialog)) {
          this.check(this.mounts.get(dialog)!);
          continue;
        }
        if (this.notDrawers.has(dialog)) continue;
        if (!isGlobalDrawer(dialog)) {
          // A drawer that is still being filled in may score low at first; only settled dialogs are remembered.
          if (dialog.querySelector('a[href]')) this.notDrawers.add(dialog);
          continue;
        }
        this.track(dialog, 'drawer');
      }
      for (const sidebar of candidateSidebars(this.doc)) {
        if (this.mounts.has(sidebar)) this.check(this.mounts.get(sidebar)!);
        else if (!this.overlapsMount(sidebar)) this.track(sidebar, 'sidebar');
      }
    } catch (error) {
      this.options.log?.('scan failed', error);
    }
  }

  /** Overlapping roots would fight over the same GitHub group (each removing the other's host), so never allow one. */
  private overlapsMount(root: HTMLElement): boolean {
    for (const other of this.mounts.keys()) if (other.isConnected && (other.contains(root) || root.contains(other))) return true;
    return false;
  }

  private track(root: HTMLElement, kind: Mount['kind']): void {
    const mount: Mount = { dialog: root, kind, observer: new MutationObserver(() => this.check(mount)), host: null, shadowHost: null, view: null, container: null, mode: 'prompt', watchdog: null, failed: false, yielded: false };
    mount.observer.observe(root, { childList: true, subtree: true });
    this.mounts.set(root, mount);
    this.options.onDrawerOpen?.();
    this.check(mount);
  }

  private check(mount: Mount): void {
    if (mount.failed) return;
    try {
      if (!mount.dialog.isConnected) {
        this.teardown(mount);
        return;
      }
      // Never more than one host per drawer. Only strays are removed (left behind by a script that is gone), never
      // another live mount's host or another live copy's: removing those is how two navigators fight forever.
      const live = new Set([...this.mounts.values()].map((m) => m.host));
      let foreign = false;
      for (const extra of [...mount.dialog.querySelectorAll<HTMLElement>(`[${HOST_ATTR}]`)]) {
        if (extra === mount.host || live.has(extra)) continue;
        if (answersAlive(extra)) foreign = true;
        else extra.remove();
      }
      if (foreign) {
        // First come, first served: the copy that mounted first keeps this spot and owns GitHub's group's marker.
        if (!mount.yielded) this.yieldTo(mount);
        return;
      }
      mount.yielded = false;
      const section = findTopRepositories(mount.dialog) ?? findLoadingSlot(mount.dialog);
      if (!section) {
        // GitHub's section is loading, being re-rendered, or unrecognisable: show nothing of ours on top of it
        // only if we never matched; once mounted, keep our host where it is until the section returns.
        if (mount.container && !mount.container.isConnected) mount.container = null;
        return;
      }
      if (mount.container && mount.container !== section.container) mount.container.removeAttribute(HIDDEN_ATTR);
      mount.container = section.container;
      if (!mount.host) this.createHost(mount, section.container);
      else if (mount.host.previousElementSibling !== section.container) section.container.after(mount.host);
      this.applyVisibility(mount);
    } catch (error) {
      this.failOpen(mount, error);
    }
  }

  private createHost(mount: Mount, container: HTMLElement): void {
    // <li> cannot host a shadow root, so inside a list the wrapper is an <li> holding the shadow host. The shadow
    // host is a custom element name, so GitHub's element selectors (div, li, …) cannot style it.
    const parentIsList = container.parentElement?.tagName === 'UL' || container.parentElement?.tagName === 'OL';
    const host = this.doc.createElement(parentIsList ? 'li' : 'div');
    host.setAttribute(HOST_ATTR, '');
    host.addEventListener(ALIVE_EVENT, (event) => {
      if (!this.options.isAlive || this.options.isAlive()) event.preventDefault();
    });
    host.style.cssText = 'list-style:none;margin:0;padding:0;display:block';
    const shadowHost = this.doc.createElement('grn-navigator');
    shadowHost.style.display = 'block';
    host.appendChild(shadowHost);
    shadowHost.setAttribute('data-grn-theme', resolveTheme(this.doc));
    container.after(host);
    mount.host = host;
    mount.shadowHost = shadowHost;
    mount.view = new NavigatorView(shadowHost, this.store, {
      onModeChange: (mode) => {
        mount.mode = mode;
        this.applyVisibility(mount);
      },
      onNavigate: () => {
        // The drawer closes behind a same-tab navigation; the sidebar stays where it is.
        if (mount.kind === 'drawer' && mount.dialog.isConnected) findCloseButton(mount.dialog)?.click();
      },
      onError: (error) => this.failOpen(mount, error),
    });
  }

  private ready(mount: Mount): boolean {
    const shadow = mount.shadowHost?.shadowRoot;
    return !!mount.host?.isConnected && !!shadow?.querySelector('.grn-section, .grn-repo');
  }

  private applyVisibility(mount: Mount): void {
    const container = mount.container;
    if (!container) return;
    mount.shadowHost?.setAttribute('data-grn-theme', resolveTheme(this.doc));
    if (mount.mode === 'replace' && this.ready(mount)) {
      if (!container.hasAttribute(HIDDEN_ATTR)) {
        container.setAttribute(HIDDEN_ATTR, '');
        this.armWatchdog(mount);
      }
    } else if (container.hasAttribute(HIDDEN_ATTR)) {
      container.removeAttribute(HIDDEN_ATTR);
    }
  }

  /** Steps aside for another copy's navigator, keeping this record so the spot is taken back if that copy leaves. */
  private yieldTo(mount: Mount): void {
    mount.yielded = true;
    if (mount.watchdog) clearTimeout(mount.watchdog);
    mount.watchdog = null;
    if (mount.host) {
      // Only reached when both copies already had a host; the group's marker was ours, so it is ours to clear.
      mount.container?.removeAttribute(HIDDEN_ATTR);
      mount.view?.destroy();
      mount.host.remove();
    }
    mount.view = null;
    mount.host = null;
    mount.shadowHost = null;
    mount.container = null;
    mount.mode = 'prompt';
  }

  /** If our navigator is not actually visible shortly after hiding GitHub's list, give GitHub's list back. */
  private armWatchdog(mount: Mount): void {
    if (mount.watchdog) clearTimeout(mount.watchdog);
    mount.watchdog = setTimeout(() => {
      mount.watchdog = null;
      if (!mount.container?.hasAttribute(HIDDEN_ATTR)) return;
      if (!mount.host?.isConnected || (this.layout && mount.host.offsetHeight === 0)) this.failOpen(mount, new Error('navigator not visible'));
    }, WATCHDOG_MS);
  }

  private failOpen(mount: Mount, error: unknown): void {
    this.options.log?.('falling back to GitHub’s own list', error);
    mount.failed = true;
    if (mount.watchdog) clearTimeout(mount.watchdog);
    mount.container?.removeAttribute(HIDDEN_ATTR);
    mount.view?.destroy();
    mount.host?.remove();
    mount.view = null;
    mount.host = null;
    mount.shadowHost = null;
    mount.container = null;
    mount.observer.disconnect();
    // Keep the record so this drawer instance is not retried in a loop; a new drawer gets a fresh attempt.
  }

  private teardown(mount: Mount): void {
    if (mount.watchdog) clearTimeout(mount.watchdog);
    mount.observer.disconnect();
    mount.view?.destroy();
    mount.host?.remove();
    mount.container?.removeAttribute(HIDDEN_ATTR);
    this.mounts.delete(mount.dialog);
  }

  /** For tests and diagnostics. */
  activeMounts(): number {
    return [...this.mounts.values()].filter((m) => m.host).length;
  }
}
