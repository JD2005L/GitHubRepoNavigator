import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * Turns the static "drawer open" fixture into a page that behaves like github.com's React drawer:
 * the drawer exists only while open, GitHub's own list shows a spinner first and arrives ~200 ms later,
 * Escape (unless prevented) / backdrop / close button remove it, and a soft navigation can be simulated.
 */
export function harnessHtml(options: { colorMode?: 'light' | 'dark'; dashboardSidebar?: boolean; login?: string } = {}): string {
  const fixture = readFileSync(join(import.meta.dirname, '..', 'tests', 'fixtures', 'github-drawer-2026-10.html'), 'utf8');
  const dom = new JSDOM(fixture);
  const doc = dom.window.document;
  if (options.colorMode) doc.documentElement.setAttribute('data-color-mode', options.colorMode);
  if (options.login) {
    // The signed-in account, as github.com names it on every page (it changes with GitHub's account switcher).
    const meta = doc.createElement('meta');
    meta.setAttribute('name', 'user-login');
    meta.setAttribute('content', options.login);
    doc.head.appendChild(meta);
  }
  const portal = doc.getElementById('__primerPortalRoot__')!;
  const template = doc.createElement('template');
  template.id = 'grn-test-drawer';
  for (const child of [...portal.childNodes]) template.content.appendChild(child);
  doc.body.appendChild(template);
  doc.body.removeAttribute('data-dialog-scroll-disabled');
  const button = doc.querySelector('button[aria-label="Open global navigation menu"]')!;
  button.setAttribute('aria-expanded', 'false');
  const main = doc.querySelector('main')!;
  main.innerHTML = '<h1 style="padding:24px;margin:0">Dashboard</h1><p style="padding:0 24px">Page content behind the drawer.</p>';
  if (options.dashboardSidebar) {
    // The github.com home page's left sidebar with its own Top repositories list (rendered by GitHub's React
    // partial ~150 ms after load, like the real page).
    // The aside and its React partial are server-rendered; the partial's nav is rendered client-side.
    const shell = doc.createElement('div');
    shell.innerHTML = readFileSync(join(import.meta.dirname, '..', 'tests', 'fixtures', 'github-dashboard-sidebar-2026-10.html'), 'utf8');
    const reactNav = shell.querySelector('nav[data-testid="dashboard-repositories"]')!;
    const sidebar = doc.createElement('template');
    sidebar.id = 'grn-test-sidebar';
    reactNav.replaceWith(sidebar);
    sidebar.content.appendChild(reactNav);
    main.prepend(shell.querySelector('aside')!);
  }
  const script = doc.createElement('script');
  script.textContent = `(() => {
    const portal = document.getElementById('__primerPortalRoot__');
    const tpl = document.getElementById('grn-test-drawer');
    const button = document.querySelector('button[aria-label="Open global navigation menu"]');
    window.grnTest = { opened: 0, githubListShownAt: null, showMoreClicks: 0 };
    // Evidence that nothing (including the extension) ever uses GitHub's own list controls.
    document.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('[data-testid="dynamic-side-panel-items-show-more"]')) window.grnTest.showMoreClicks++;
    }, true);
    function topGroup(root) {
      const h = [...root.querySelectorAll('h3')].find((x) => x.textContent.includes('Top repositories'));
      return h && h.closest('li[data-component="ActionList.Group"]');
    }
    function open() {
      if (portal.firstElementChild) return;
      const frag = tpl.content.cloneNode(true);
      const group = topGroup(frag);
      const spinner = document.createElement('li');
      spinner.setAttribute('data-component', 'ActionList.Group');
      spinner.innerHTML = '<ul><li style="padding:12px;text-align:center"><span data-testid="dynamic-side-content-loader">Loading…</span></li></ul>';
      group.replaceWith(spinner);
      portal.appendChild(frag);
      window.grnTest.opened++;
      button.setAttribute('aria-expanded', 'true');
      document.body.setAttribute('data-dialog-scroll-disabled', '');
      setTimeout(() => { if (spinner.isConnected) { spinner.replaceWith(group); window.grnTest.githubListShownAt = performance.now(); } }, 200);
      const close = portal.querySelector('[role="dialog"] button[aria-labelledby]');
      close && close.addEventListener('click', shut);
    }
    function shut() {
      portal.replaceChildren();
      button.setAttribute('aria-expanded', 'false');
      document.body.removeAttribute('data-dialog-scroll-disabled');
      button.focus();
    }
    button.addEventListener('click', open);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented && portal.firstElementChild) shut(); });
    portal.addEventListener('click', (e) => { if (e.target === e.currentTarget.querySelector('[data-position-regular="left"]:not([role="dialog"])')) shut(); });
    const sidebarTpl = document.getElementById('grn-test-sidebar');
    if (sidebarTpl) setTimeout(() => sidebarTpl.replaceWith(sidebarTpl.content.cloneNode(true)), 150);
    window.grnTest.close = shut;
    window.grnTest.open = open;
    window.grnTest.softNav = () => {
      document.querySelector('main').innerHTML = '<h1 style="padding:24px;margin:0">Another page</h1>';
      document.dispatchEvent(new Event('turbo:render'));
      document.dispatchEvent(new Event('soft-nav:end'));
    };
    window.grnTest.rerenderGithubGroup = () => {
      const g = topGroup(portal);
      if (!g) return;
      const fresh = g.cloneNode(true);
      fresh.removeAttribute('data-grn-hidden'); // React would render a brand-new element without our marker
      g.replaceWith(fresh);
    };
  })();`;
  doc.body.appendChild(script);
  return dom.serialize();
}
