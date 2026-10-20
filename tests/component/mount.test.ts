// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrawerMounter, HIDDEN_ATTR, HOST_ATTR } from '../../src/content/mount';
import { ContentStore } from '../../src/content/store';
import { ACCOUNT_ID, asLoading, drawerDialog, fakeBackend, flush, loadFixture, navState, sidebarGroup, topReposGroup, withDashboardSidebar, withoutDrawer } from '../helpers/dom';

let mounter: DrawerMounter | null = null;
afterEach(() => mounter?.stop());

async function start(state = navState()) {
  const backend = fakeBackend(state);
  const store = new ContentStore(backend.transport);
  await store.load();
  mounter = new DrawerMounter(document, store);
  mounter.start();
  await flush();
  return { backend, store, mounter };
}

const hosts = () => document.querySelectorAll(`[${HOST_ATTR}]`);

describe('DrawerMounter', () => {
  beforeEach(() => loadFixture());

  it('mounts one navigator right after Top repositories and hides only that group', async () => {
    const before = drawerDialog().cloneNode(true) as HTMLElement;
    await start();
    expect(hosts()).toHaveLength(1);
    const group = topReposGroup();
    expect(group.nextElementSibling).toBe(hosts()[0]);
    expect(group.hasAttribute(HIDDEN_ATTR)).toBe(true);
    expect(document.querySelectorAll(`[${HIDDEN_ATTR}]`)).toHaveLength(1);
    // Everything GitHub owns is unchanged apart from our marker attribute.
    const after = drawerDialog().cloneNode(true) as HTMLElement;
    after.querySelector(`[${HOST_ATTR}]`)!.remove();
    after.querySelector(`[${HIDDEN_ATTR}]`)!.removeAttribute(HIDDEN_ATTR);
    expect(after.outerHTML).toBe(before.outerHTML);
    expect(document.getElementById('grn-doc-css')!.textContent).toBe(`[${HIDDEN_ATTR}]{display:none!important}`);
  });

  it('keeps GitHub’s list visible until there is a complete inventory to show', async () => {
    await start(navState({ auth: { kind: 'signed-out', clientIdConfigured: true, problem: null }, repos: [] }));
    expect(hosts()).toHaveLength(1);
    expect(topReposGroup().hasAttribute(HIDDEN_ATTR)).toBe(false);
    expect(hosts()[0]!.querySelector('grn-navigator')!.shadowRoot!.textContent).toContain('Connect GitHub');
  });

  it('switches to replacing as soon as the inventory arrives', async () => {
    const { backend } = await start(navState({ repos: [] }));
    expect(topReposGroup().hasAttribute(HIDDEN_ATTR)).toBe(false);
    backend.broadcast({ type: 'nav/inventory', account: ACCOUNT_ID, inventory: navState().inventory });
    await flush();
    expect(topReposGroup().hasAttribute(HIDDEN_ATTR)).toBe(true);
  });

  it('is idempotent across rescans, navigation events and unrelated mutations', async () => {
    const { mounter } = await start();
    for (let i = 0; i < 5; i++) {
      mounter.scan();
      document.dispatchEvent(new Event('turbo:render'));
      document.dispatchEvent(new Event('soft-nav:end'));
      document.body.appendChild(document.createElement('div'));
    }
    await flush();
    expect(hosts()).toHaveLength(1);
    expect(mounter.activeMounts()).toBe(1);
  });

  it('cleans up when the drawer closes and mounts again when it reopens', async () => {
    const { mounter } = await start();
    const portal = document.getElementById('__primerPortalRoot__')!;
    const drawer = portal.firstElementChild!;
    drawer.remove();
    await flush();
    expect(hosts()).toHaveLength(0);
    expect(mounter.activeMounts()).toBe(0);
    portal.appendChild(drawer);
    await flush();
    expect(hosts()).toHaveLength(1);
    expect(topReposGroup().hasAttribute(HIDDEN_ATTR)).toBe(true);
  });

  it('follows React re-rendering the group (search toggle, Show more, refetch)', async () => {
    await start();
    const old = topReposGroup();
    const replacement = old.cloneNode(true) as HTMLElement;
    replacement.removeAttribute(HIDDEN_ATTR);
    old.replaceWith(replacement);
    await flush();
    expect(replacement.hasAttribute(HIDDEN_ATTR)).toBe(true);
    expect(replacement.nextElementSibling).toBe(hosts()[0]);
    expect(hosts()).toHaveLength(1);
  });

  it('replaces GitHub\u2019s loading spinner straight away, then follows the real group when it arrives', async () => {
    loadFixture();
    const loaded = topReposGroup().cloneNode(true) as HTMLElement;
    loadFixture(asLoading);
    await start();
    const spinnerGroup = drawerDialog().querySelector('[data-testid="dynamic-side-content-loader"]')!.closest('li[data-component="ActionList.Group"]')!;
    expect(hosts()).toHaveLength(1);
    expect(spinnerGroup.nextElementSibling).toBe(hosts()[0]);
    expect(spinnerGroup.hasAttribute(HIDDEN_ATTR)).toBe(true); // no flash of GitHub's spinner or list
    spinnerGroup.replaceWith(loaded); // React swaps the spinner for the data
    await flush();
    expect(hosts()).toHaveLength(1);
    expect(topReposGroup().hasAttribute(HIDDEN_ATTR)).toBe(true);
    expect(topReposGroup().nextElementSibling).toBe(hosts()[0]);
  });

  it('steps aside when the extension context is gone (extension reloaded under an open tab)', async () => {
    const backend = fakeBackend(navState());
    const store = new ContentStore(backend.transport);
    await store.load();
    let alive = true;
    mounter = new DrawerMounter(document, store, { isAlive: () => alive });
    mounter.start();
    await flush();
    expect(topReposGroup().hasAttribute(HIDDEN_ATTR)).toBe(true);
    alive = false;
    // The user closes and reopens the drawer: the orphaned script must not mount again.
    const portal = document.getElementById('__primerPortalRoot__')!;
    const drawer = portal.firstElementChild!;
    drawer.remove();
    await flush();
    portal.appendChild(drawer);
    await flush();
    expect(hosts()).toHaveLength(0);
    expect(topReposGroup().hasAttribute(HIDDEN_ATTR)).toBe(false);
  });

  it('closes the drawer after a repository link starts a same-tab navigation', async () => {
    await start();
    let closed = 0;
    const closeButton = drawerDialog().querySelector<HTMLButtonElement>('button[aria-labelledby]')!;
    closeButton.addEventListener('click', () => closed++);
    const link = hosts()[0]!.querySelector('grn-navigator')!.shadowRoot!.querySelector<HTMLAnchorElement>('[data-repo-link]')!;
    link.addEventListener('click', (e) => e.preventDefault(), { once: true }); // jsdom cannot navigate
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0, ctrlKey: true }));
    await new Promise((r) => setTimeout(r, 80));
    expect(closed).toBe(0); // ctrl+click opens a new tab: keep the drawer
    link.addEventListener('click', (e) => e.preventDefault(), { once: true });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 80));
    expect(closed).toBe(1);
  });

  it('hosts the shadow root on a custom element GitHub\u2019s CSS cannot target', async () => {
    await start();
    const host = hosts()[0]!;
    expect(host.tagName).toBe('LI');
    expect(host.firstElementChild!.tagName).toBe('GRN-NAVIGATOR');
    expect(host.firstElementChild!.shadowRoot).toBeTruthy();
  });

  it('fails open when the navigator cannot render', async () => {
    const backend = fakeBackend(navState());
    const store = new ContentStore(backend.transport);
    await store.load();
    store.view = () => {
      throw new Error('boom');
    };
    mounter = new DrawerMounter(document, store);
    mounter.start();
    await flush();
    expect(topReposGroup().hasAttribute(HIDDEN_ATTR)).toBe(false);
    expect(hosts()).toHaveLength(0);
    mounter.scan();
    await flush();
    expect(hosts()).toHaveLength(0); // no retry loop on the same drawer
    expect((store as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0); // no zombie view left subscribed
  });

  it('marks the host with the resolved GitHub color mode', async () => {
    document.documentElement.setAttribute('data-color-mode', 'dark');
    await start();
    expect(hosts()[0]!.querySelector('[data-grn-theme]')!.getAttribute('data-grn-theme')).toBe('dark');
  });

  it('leaves pages without the drawer untouched', async () => {
    document.getElementById('__primerPortalRoot__')!.replaceChildren();
    await start();
    expect(hosts()).toHaveLength(0);
    expect(document.querySelectorAll(`[${HIDDEN_ATTR}]`)).toHaveLength(0);
  });
});

describe('DrawerMounter on the dashboard sidebar', () => {
  const aside = () => document.querySelector<HTMLElement>('aside[aria-label="Dashboard menu"]')!;
  const sidebarHost = () => aside().querySelector(`[${HOST_ATTR}]`);

  it('replaces only the sidebar’s Top repositories group, leaving the rest of the sidebar alone', async () => {
    loadFixture((doc) => {
      withoutDrawer(doc);
      withDashboardSidebar(doc);
    });
    const before = aside().cloneNode(true) as HTMLElement;
    await start();
    expect(hosts()).toHaveLength(1);
    expect(sidebarGroup().nextElementSibling).toBe(sidebarHost());
    expect(sidebarGroup().hasAttribute(HIDDEN_ATTR)).toBe(true);
    expect(document.querySelectorAll(`[${HIDDEN_ATTR}]`)).toHaveLength(1);
    expect(aside().querySelector('a[href="/feed"]')!.closest(`[${HIDDEN_ATTR}]`)).toBeNull();
    const after = aside().cloneNode(true) as HTMLElement;
    after.querySelector(`[${HOST_ATTR}]`)!.remove();
    after.querySelector(`[${HIDDEN_ATTR}]`)!.removeAttribute(HIDDEN_ATTR);
    expect(after.outerHTML).toBe(before.outerHTML);
  });

  it('runs alongside an open drawer: one navigator in each place', async () => {
    loadFixture(withDashboardSidebar);
    await start();
    expect(hosts()).toHaveLength(2);
    expect(topReposGroup().hasAttribute(HIDDEN_ATTR)).toBe(true);
    expect(sidebarGroup().hasAttribute(HIDDEN_ATTR)).toBe(true);
    expect(sidebarHost()).not.toBeNull();
  });

  it('mounts when GitHub renders the sidebar list after the page loads', async () => {
    loadFixture(withoutDrawer);
    await start();
    expect(hosts()).toHaveLength(0);
    withDashboardSidebar(document);
    await flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(hosts()).toHaveLength(1);
    expect(sidebarGroup().hasAttribute(HIDDEN_ATTR)).toBe(true);
  });

  it('uses one root per sidebar when React renders the list into the server-rendered sidebar later (no fight, no freeze)', async () => {
    let nav: Element | null = null;
    loadFixture((doc) => {
      withoutDrawer(doc);
      withDashboardSidebar(doc);
      nav = doc.querySelector('nav[data-testid="dashboard-repositories"]');
      nav!.remove();
    });
    await start();
    expect(hosts()).toHaveLength(0);
    // Count every insertion/removal of our host: a fight between two roots shows up as an unbounded number.
    let churn = 0;
    const watch = new MutationObserver((records) => {
      for (const r of records) for (const n of [...r.addedNodes, ...r.removedNodes]) if (n instanceof Element && n.hasAttribute(HOST_ATTR)) churn++;
    });
    watch.observe(document.body, { childList: true, subtree: true });
    document.querySelector('[data-target="react-partial.reactRoot"]')!.appendChild(document.importNode(nav!, true));
    for (let i = 0; i < 5; i++) {
      await flush();
      await new Promise((r) => setTimeout(r, 0));
    }
    watch.disconnect();
    expect(hosts()).toHaveLength(1);
    expect(sidebarGroup().hasAttribute(HIDDEN_ATTR)).toBe(true);
    expect(churn).toBeLessThanOrEqual(2);
  });

  it('still finds the list through the labelled dashboard sidebar if GitHub drops the test id', async () => {
    loadFixture((doc) => {
      withoutDrawer(doc);
      withDashboardSidebar(doc);
      doc.querySelector('nav[data-testid="dashboard-repositories"]')!.removeAttribute('data-testid');
    });
    await start();
    expect(hosts()).toHaveLength(1);
    expect(sidebarGroup().hasAttribute(HIDDEN_ATTR)).toBe(true);
    expect(aside().querySelector('a[href="/feed"]')!.closest(`[${HIDDEN_ATTR}]`)).toBeNull();
  });

  it('does not try to close anything when a sidebar repository link is followed', async () => {
    loadFixture(withDashboardSidebar);
    await start();
    let closed = 0;
    drawerDialog().querySelector<HTMLButtonElement>('button[aria-labelledby]')!.addEventListener('click', () => closed++);
    const link = sidebarHost()!.querySelector('grn-navigator')!.shadowRoot!.querySelector<HTMLAnchorElement>('[data-repo-link]')!;
    link.addEventListener('click', (e) => e.preventDefault(), { once: true });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 80));
    expect(closed).toBe(0);
  });

  it('keeps the sidebar’s list while signed out, showing the setup prompt above it', async () => {
    loadFixture((doc) => {
      withoutDrawer(doc);
      withDashboardSidebar(doc);
    });
    await start(navState({ auth: { kind: 'signed-out', clientIdConfigured: false, problem: null }, repos: [] }));
    expect(sidebarGroup().hasAttribute(HIDDEN_ATTR)).toBe(false);
    expect(sidebarHost()!.querySelector('grn-navigator')!.shadowRoot!.textContent).toContain('Repo Navigator needs setup');
  });
});
