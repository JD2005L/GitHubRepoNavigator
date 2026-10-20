import { UNCATEGORIZED_ID, buildView, deleteGuard, newSectionId, type LayoutOp, type SectionView } from '../../shared/layout/model';
import { needsStartChoice, type NavState, type Request } from '../../shared/messages';
import type { RepoRecord } from '../../shared/types';
import type { ContentStore } from '../store';
import { DragController, type RepoDropItem, type RepoDropTarget, type SectionBox } from './dnd';
import { formatClock, formatRelative, h, highlightRange, icon } from './dom';
import type { IconName } from './icons';
import { STYLES } from './styles';

export type DisplayMode = 'replace' | 'prompt';

/**
 * GitHub's own list is only hidden once we can show something at least as complete: an authorization (current
 * or expired) and a fetched inventory. Until then the navigator is a small prompt above GitHub's list.
 */
export function displayMode(state: NavState | null): DisplayMode {
  if (!state) return 'prompt';
  const authorized = state.auth.kind === 'signed-in' || state.auth.kind === 'expired';
  return authorized && state.inventory.repos.length > 0 ? 'replace' : 'prompt';
}

export function matchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function repoMatches(repo: RepoRecord, terms: string[]): boolean {
  if (!terms.length) return true;
  const key = `${repo.owner}/${repo.name}`.toLowerCase();
  return terms.every((t) => key.includes(t));
}

export function repoUrl(repo: RepoRecord): string {
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

type Menu = { kind: 'repo'; repoId: number } | { kind: 'section'; sectionId: string };

interface UiState {
  query: string;
  renaming: string | null;
  creating: { moveRepoId: number | null } | null;
  menu: Menu | null;
  flash: number | null;
  notice: string | null;
}

export interface NavigatorOptions {
  now?: () => number;
  onModeChange?: (mode: DisplayMode) => void;
  /** A repository link started a same-tab navigation (the drawer should close once it is under way). */
  onNavigate?: () => void;
  /** A later (queued) render failed; the mounter gives GitHub's list back. */
  onError?: (error: unknown) => void;
}

/**
 * The navigator UI, rendered into a shadow root on `host`. Built only with DOM APIs and text nodes.
 */
export class NavigatorView {
  readonly shadow: ShadowRoot;
  private readonly frame: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private readonly live: HTMLDivElement;
  private readonly menuHost: HTMLDivElement;
  private readonly search: HTMLInputElement;
  private readonly searchBox: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly titleCount: HTMLSpanElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly newButton: HTMLButtonElement;
  private readonly drag: DragController;
  private unsubscribe: () => void = () => undefined;
  private ui: UiState = { query: '', renaming: null, creating: null, menu: null, flash: null, notice: null };
  private mode: DisplayMode | null = null;
  private views: SectionView[] = [];
  private repoById = new Map<number, RepoRecord>();
  /** Rows are reused across renders when nothing they show changed (keeps avatars loaded, renders fast). */
  private rowCache = new Map<number, { signature: string; element: HTMLElement }>();
  private renderQueued = false;
  /** A background update arrived while the user was renaming, creating a section or in a menu. */
  private deferred = false;
  private destroyed = false;
  private readonly now: () => number;

  constructor(
    readonly host: HTMLElement,
    private readonly store: ContentStore,
    private readonly options: NavigatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    this.shadow.replaceChildren();
    const style = document.createElement('style');
    style.textContent = STYLES;

    this.titleCount = h('span', { className: 'grn-title-count' });
    this.refreshButton = this.iconButton('sync', 'Refresh repositories', () => void this.act({ type: 'inventory/refresh', force: true }));
    this.newButton = this.iconButton('plus', 'New section', () => this.startCreate(null));
    this.header = h(
      'div',
      { className: 'grn-header' },
      h('h2', { className: 'grn-title', id: 'grn-title' }, 'Repositories', this.titleCount),
      this.refreshButton,
      this.newButton,
      this.iconButton('gear', 'Repo Navigator settings', () => void this.act({ type: 'options/open' })),
    );
    this.search = h('input', {
      type: 'search',
      placeholder: 'Find a repository…',
      'aria-label': 'Filter repositories',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-controls': 'grn-sections',
    });
    this.search.addEventListener('input', () => {
      this.ui.query = this.search.value;
      this.queueRender();
    });
    this.search.addEventListener('keydown', (e) => this.onSearchKey(e));
    const clear = this.iconButton('x', 'Clear filter', () => {
      this.search.value = '';
      this.ui.query = '';
      this.search.focus();
      this.queueRender();
    });
    clear.classList.add('grn-clear');
    this.searchBox = h('div', { className: 'grn-search', role: 'search' }, icon('search'), this.search, clear);
    this.body = h('div', { className: 'grn-body' });
    this.layer = h('div', { className: 'grn-layer' });
    this.menuHost = h('div', { className: 'grn-menu-host' });
    this.live = h('div', { className: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
    const help = h('p', { className: 'sr-only', id: 'grn-help' }, 'Press Alt with Up or Down Arrow to move a repository or section. Use the actions button to move a repository to another section.');
    this.frame = h('div', { className: 'grn', 'aria-labelledby': 'grn-title', role: 'group' }, this.header, this.searchBox, this.body, help, this.live, this.layer, this.menuHost);
    this.shadow.append(style, this.frame);

    this.frame.addEventListener('keydown', (e) => this.onKey(e));
    // GitHub's keyboard shortcuts ignore form fields, but from outside the shadow root our inputs look like a
    // plain element, so typing "s", "/", "." or "?" in the filter would trigger them. Keep typed keys inside
    // (Escape still reaches the drawer, which closes it when nothing of ours handled it).
    for (const type of ['keydown', 'keypress', 'keyup']) {
      this.frame.addEventListener(type, (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.matches('input, textarea') && (event as KeyboardEvent).key !== 'Escape') event.stopPropagation();
      });
    }
    this.drag = new DragController(this.frame, {
      layer: this.layer,
      repoTargets: () => this.repoTargets(),
      sectionTargets: () => this.sectionTargets(),
      dropRepo: (repoId, target) => this.dropRepo(repoId, target),
      dropSection: (sectionId, before) => void this.applyOps([{ type: 'moveSection', sectionId, beforeSectionId: before }], `Moved section ${this.sectionName(sectionId)}.`),
      scrollContainer: () => scrollParent(this.host),
      label: (kind, id) => (kind === 'repo' ? this.repoLabel(Number(id)) : this.sectionName(id)),
      setDragging: (kind, id, active) => {
        const el = this.frame.querySelector(kind === 'repo' ? `[data-drag-repo="${id}"]` : `[data-section-id="${id}"]`);
        el?.classList.toggle('is-dragging', active);
      },
      highlightSection: (sectionId) => {
        for (const el of this.frame.querySelectorAll('.grn-section.is-drop-target')) el.classList.remove('is-drop-target');
        if (sectionId) this.frame.querySelector(`[data-section-id="${sectionId}"]`)?.classList.add('is-drop-target');
      },
    });
    try {
      this.render();
    } catch (error) {
      // Nothing may stay subscribed when the first render fails (the mounter fails open and drops this view).
      this.drag.destroy();
      throw error;
    }
    this.unsubscribe = store.onChange(() => this.queueRender());
    document.addEventListener('pointerdown', this.onOutsidePointer, true);
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    this.drag.destroy();
    document.removeEventListener('pointerdown', this.onOutsidePointer, true);
  }

  private iconButton(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
    const button = h('button', { type: 'button', className: 'grn-icon-btn', 'aria-label': label, title: label }, icon(name));
    button.addEventListener('click', onClick);
    return button;
  }

  /** True while the user is typing a name or using a menu: background renders would destroy that state. */
  private editing(): boolean {
    return this.ui.renaming !== null || this.ui.creating !== null || this.ui.menu !== null;
  }

  private queueRender(): void {
    if (this.destroyed) return;
    if (this.editing()) {
      this.deferred = true;
      return;
    }
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (this.destroyed) return;
      try {
        this.render();
      } catch (error) {
        this.options.onError?.(error);
      }
    });
  }

  /** Runs a non-layout request (refresh, open Options) and shows why it failed, if it did. */
  private async act(request: Request): Promise<void> {
    const response = await this.store.send(request);
    if (response.ok) return;
    this.ui.notice = response.error;
    this.announce(response.error);
    this.queueRender();
  }

  private state(): NavState | null {
    return this.store.view();
  }

  private editable(state: NavState): boolean {
    return state.layout.editable;
  }

  // ---------------------------------------------------------------- rendering

  render(): void {
    this.deferred = false;
    const state = this.state();
    const mode = displayMode(state);
    this.renderBody(state, mode);
    // Announce the mode only after the content exists, so the mounter's readiness check sees real rows.
    if (mode !== this.mode) {
      this.mode = mode;
      this.options.onModeChange?.(mode);
    }
  }

  private renderBody(state: NavState | null, mode: DisplayMode): void {
    const focus = this.captureFocus();
    this.header.hidden = mode !== 'replace';
    this.searchBox.hidden = mode !== 'replace';
    this.frame.toggleAttribute('data-readonly', !!state && !this.editable(state));
    if (mode === 'prompt' || !state) {
      this.body.replaceChildren(this.renderPrompt(state));
      this.closeMenu(false);
      this.restoreFocus(focus);
      return;
    }

    const repos = state.inventory.repos;
    this.repoById = new Map(repos.map((r) => [r.id, r]));
    for (const id of this.rowCache.keys()) if (!this.repoById.has(id)) this.rowCache.delete(id);
    this.views = buildView(state.layout.layout, repos);
    const terms = matchTerms(this.ui.query);
    const searching = terms.length > 0;
    const editable = this.editable(state) && !searching;
    this.newButton.setAttribute('aria-disabled', String(!this.editable(state)));
    const busy = state.inventory.status.kind === 'refreshing';
    this.refreshButton.classList.toggle('is-busy', busy);
    this.refreshButton.setAttribute('aria-busy', String(busy));
    this.titleCount.textContent = String(repos.length);

    let matches = 0;
    const sectionItems: HTMLElement[] = [];
    for (const view of this.views) {
      const visible = searching ? view.repos.filter((r) => repoMatches(r, terms)) : view.repos;
      matches += visible.length;
      if (searching && !visible.length) continue;
      sectionItems.push(this.renderSection(view, visible, terms, editable, searching));
    }

    const children: (HTMLElement | null)[] = [this.renderStartChoice(state), ...this.renderBanners(state)];
    if (this.ui.creating) children.push(this.renderCreateRow());
    const list = h('ul', { className: 'grn-sections', id: 'grn-sections', role: 'list', 'aria-describedby': 'grn-help' }, ...sectionItems);
    children.push(list);
    if (searching && matches === 0) children.push(h('div', { className: 'grn-empty' }, `No repositories match “${this.ui.query.trim()}”.`));
    children.push(this.renderFooter(state, searching ? matches : null));
    this.body.replaceChildren(...children.filter((c): c is HTMLElement => c !== null));
    if (this.ui.menu) this.openMenu(this.ui.menu, false);
    this.restoreFocus(focus);
    if (this.ui.flash !== null) {
      const id = this.ui.flash;
      this.ui.flash = null;
      this.frame.querySelector(`[data-drag-repo="${id}"]`)?.classList.add('is-moved');
    }
  }

  private renderPrompt(state: NavState | null): HTMLElement {
    const box = (title: string, text: string, ...actions: HTMLElement[]) =>
      h('div', { className: 'grn-prompt', role: 'status' }, h('strong', {}, title), h('p', {}, text), ...actions);
    const openOptions = (label: string) => {
      const b = h('button', { type: 'button', className: 'grn-btn' }, label);
      b.addEventListener('click', () => void this.act({ type: 'options/open' }));
      return b;
    };
    const retry = () => {
      const b = h('button', { type: 'button', className: 'grn-btn' }, icon('sync'), 'Try again');
      b.addEventListener('click', () => void this.act({ type: 'inventory/refresh', force: true }));
      return b;
    };
    if (!state) return box('Repo Navigator', 'Loading…');
    const { auth, inventory } = state;
    switch (auth.kind) {
      case 'signed-out':
        if (!auth.clientIdConfigured) return box('Repo Navigator needs setup', 'Add your GitHub App client ID to list and organize every repository here.', openOptions('Open setup'));
        if (state.accounts.length) {
          // Another account is connected; this page is signed in as one that is not (GitHub's account switcher).
          const who = state.pageLogin ? `@${state.pageLogin}` : 'this account';
          const connected = state.accounts.map((l) => `@${l}`).join(', ');
          return box(`Connect ${who} too`, `Repo Navigator is connected to ${connected}. Connect ${who} to see its repositories and sections here.`, openOptions(`Connect ${who}`));
        }
        return box('See all your repositories here', 'Connect GitHub (read-only) to replace this short list with every repository you can access, in your own sections.', openOptions('Connect GitHub'));
      case 'authorizing':
        return box('Finish connecting GitHub', '', h('p', {}, 'Enter ', h('span', { className: 'grn-code' }, auth.userCode), ' at github.com/login/device.'), openOptions('Show sign-in'));
      case 'expired':
        return box('Reconnect GitHub', 'Your GitHub authorization expired.', openOptions('Reconnect'));
      case 'signed-in': {
        const status = inventory.status;
        if (status.kind === 'refreshing' || (status.kind === 'idle' && inventory.fetchedAt === null)) return box('Loading all your repositories…', 'This can take a few seconds for large accounts.');
        if (status.kind === 'rate-limited') return box('GitHub rate limit reached', `Repo Navigator will try again at ${formatClock(status.resetAt)}.`, retry());
        if (status.kind === 'offline') return box('You are offline', 'Repositories will load when GitHub is reachable.', retry());
        if (status.kind === 'error') return box('Could not load repositories', status.message, retry());
        return box('No repositories yet', 'Install the GitHub App on the accounts and organizations whose repositories you want to see.', openOptions('Open setup'));
      }
    }
  }

  /** First run, nothing organized yet: ask once how to start, right where the list is. */
  private renderStartChoice(state: NavState): HTMLElement | null {
    if (!needsStartChoice(state)) return null;
    const suggest = h('button', { type: 'button', className: 'grn-btn grn-btn-primary' }, 'Suggest sections');
    suggest.addEventListener('click', () => void this.act({ type: 'options/open', tab: 'organize', suggest: true }));
    const empty = h('button', { type: 'button', className: 'grn-btn' }, 'Start with one list');
    empty.addEventListener('click', () => void this.act({ type: 'onboarding/start-empty' }));
    const count = state.inventory.repos.length;
    return h(
      'div',
      { className: 'grn-start', role: 'group', 'aria-label': 'How to start' },
      h('strong', {}, 'How do you want to start?'),
      h('p', {}, `Repo Navigator can sort your ${count} ${count === 1 ? 'repository' : 'repositories'} into sections for you. You see a preview first and can undo it. Or start with one list and make sections yourself with +.`),
      h('div', { className: 'grn-start-actions' }, suggest, empty),
    );
  }

  private renderBanners(state: NavState): HTMLElement[] {
    const banners: HTMLElement[] = [];
    const banner = (iconName: IconName, ...content: (Node | string)[]) =>
      h('div', { className: 'grn-banner', role: 'status' }, icon(iconName), h('div', { className: 'grn-banner-body' }, ...content));
    const link = (label: string, onClick: () => void) => {
      const b = h('button', { type: 'button', className: 'grn-link-btn' }, label);
      b.addEventListener('click', onClick);
      return b;
    };
    const since = state.inventory.fetchedAt ? ` from ${formatRelative(state.inventory.fetchedAt, this.now())}` : '';
    if (state.auth.kind === 'expired') {
      banners.push(banner('alert', 'GitHub authorization expired. Showing your saved list. ', link('Reconnect', () => void this.act({ type: 'options/open' }))));
    }
    const status = state.inventory.status;
    if (status.kind === 'rate-limited') banners.push(banner('alert', `GitHub rate limit reached. Showing your saved list; trying again at ${formatClock(status.resetAt)}.`));
    if (status.kind === 'offline') banners.push(banner('alert', `GitHub is unreachable. Showing your saved list${since}.`));
    if (status.kind === 'error') banners.push(banner('alert', `${status.message} Showing your saved list${since}. `, link('Try again', () => void this.act({ type: 'inventory/refresh', force: true }))));
    // A connected app with no installation (or only hand-picked repositories) silently shows a short list;
    // say so where the user is looking, and send them to the step that fixes it.
    if (state.auth.kind === 'signed-in' && state.inventory.fetchedAt !== null && status.kind === 'idle') {
      const live = state.inventory.installations.filter((i) => !i.suspended);
      const finish = () => link('Finish setup', () => void this.act({ type: 'options/open' }));
      if (live.length === 0) banners.push(banner('alert', 'Only public repositories are showing: the GitHub App is not installed on your account yet. ', finish()));
      else if (live.some((i) => i.repositorySelection !== 'all')) banners.push(banner('alert', 'Some accounts only share selected repositories with the app, so some are missing. ', finish()));
    }
    const sync = state.layout.sync;
    if (sync.kind === 'readonly') banners.push(banner('lock', sync.reason));
    if (sync.kind === 'error') banners.push(banner('alert', sync.message));
    const notice = this.store.lastError ?? this.ui.notice;
    if (notice) banners.push(banner('alert', notice));
    return banners;
  }

  private renderFooter(state: NavState, matches: number | null): HTMLElement {
    const parts: string[] = [];
    const total = state.inventory.repos.length;
    parts.push(matches === null ? `${total} ${total === 1 ? 'repository' : 'repositories'}` : `${matches} of ${total} match`);
    if (state.inventory.status.kind === 'refreshing') parts.push('refreshing…');
    else if (state.inventory.fetchedAt) parts.push(`updated ${formatRelative(state.inventory.fetchedAt, this.now())}`);
    const sync = state.layout.sync;
    if (sync.kind === 'ok' && sync.pending) parts.push('saving…');
    // Nothing organized yet: offer the automatic suggestion where the user is looking.
    const unorganized = total >= 8 && state.auth.kind === 'signed-in' && !state.layout.layout.sections.some((s) => s.id !== UNCATEGORIZED_ID);
    let suggest: HTMLButtonElement | null = null;
    if (unorganized && state.layout.editable) {
      suggest = h('button', { type: 'button', className: 'grn-link-btn' }, 'Suggest sections');
      suggest.addEventListener('click', () => void this.act({ type: 'options/open', tab: 'organize', suggest: true }));
    }
    return h('div', { className: 'grn-footer' }, h('span', { className: 'grn-footer-text' }, parts.join(' · ')), suggest);
  }

  private renderCreateRow(): HTMLElement {
    const input = h('input', { className: 'grn-rename', type: 'text', maxlength: '60', placeholder: 'Section name', 'aria-label': 'New section name', 'data-focus': 'create|input' });
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      const pending = this.ui.creating;
      this.ui.creating = null;
      if (!name) {
        this.queueRender();
        return;
      }
      const sectionId = newSectionId();
      const ops: LayoutOp[] = [{ type: 'createSection', sectionId, name, beforeSectionId: UNCATEGORIZED_ID }];
      if (pending?.moveRepoId != null) ops.push({ type: 'moveRepo', repoId: pending.moveRepoId, toSectionId: sectionId, beforeRepoId: null });
      void this.applyOps(ops, pending?.moveRepoId != null ? `Created section ${name} and moved ${this.repoLabel(pending.moveRepoId)} into it.` : `Created section ${name}.`, `section:${sectionId}|toggle`);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done = true;
        this.ui.creating = null;
        this.queueRender();
      }
    });
    input.addEventListener('blur', () => commit());
    queueMicrotask(() => input.focus());
    return h('div', { className: 'grn-new-section' }, icon('file-directory'), input);
  }

  private renderSection(view: SectionView, repos: RepoRecord[], terms: string[], editable: boolean, searching: boolean): HTMLElement {
    const { section } = view;
    const automatic = section.id === UNCATEGORIZED_ID;
    const expanded = searching || !section.collapsed;
    const listId = `grn-list-${section.id}`;
    const nameNode =
      this.ui.renaming === section.id
        ? this.renderRename(section.id, section.name)
        : (() => {
            const toggle = h(
              'button',
              {
                type: 'button',
                className: 'grn-section-toggle',
                'aria-expanded': String(expanded),
                'aria-controls': listId,
                'data-focus': `section:${section.id}|toggle`,
                'data-section-toggle': section.id,
              },
              icon('chevron-down', 'grn-icon grn-chevron'),
              h('span', { className: 'grn-section-name' }, section.name),
              automatic ? h('span', { className: 'sr-only' }, ' (sorted automatically)') : null,
              h('span', { className: 'grn-section-count', 'aria-label': `${repos.length} repositories` }, searching ? `${repos.length}/${view.repos.length}` : String(view.repos.length)),
            );
            toggle.addEventListener('click', () => {
              if (searching) return;
              void this.applyOps([{ type: 'setCollapsed', sectionId: section.id, collapsed: !section.collapsed }], `${section.name} ${section.collapsed ? 'expanded' : 'collapsed'}.`);
            });
            return toggle;
          })();
    const menuButton = h(
      'button',
      {
        type: 'button',
        className: 'grn-icon-btn',
        'aria-label': `Actions for section ${section.name}`,
        title: 'Section actions',
        'aria-haspopup': 'menu',
        'aria-expanded': String(this.ui.menu?.kind === 'section' && this.ui.menu.sectionId === section.id),
        'data-focus': `section:${section.id}|menu`,
        'data-menu-anchor': `section:${section.id}`,
      },
      icon('kebab-horizontal'),
    );
    menuButton.addEventListener('click', () => this.toggleMenu({ kind: 'section', sectionId: section.id }));
    const grip = editable ? h('span', { className: 'grn-grip', 'data-grip': true, title: 'Drag to reorder sections', 'aria-hidden': 'true' }, icon('grabber')) : null;
    const header = h('div', { className: 'grn-section-header' }, grip, nameNode, menuButton);

    const rows: HTMLElement[] = repos.map((repo) => this.renderRepo(repo, terms, editable));
    if (expanded && !repos.length && !searching) {
      rows.push(h('li', { className: 'grn-empty' }, automatic ? 'Every repository is in a section.' : editable ? 'Drag repositories here, or use a repository’s actions menu.' : 'Empty.'));
    }
    if (expanded && view.unavailable > 0 && !searching) {
      rows.push(h('li', { className: 'grn-more' }, `${view.unavailable} more not available on this device`));
    }
    const list = h('ul', { className: 'grn-repos', id: listId, role: 'list', hidden: !expanded });
    list.append(...rows);
    const props: Record<string, string | boolean> = { className: 'grn-section', 'data-section-id': section.id };
    if (editable) props['data-drag-section'] = section.id;
    if (automatic) props['data-automatic'] = true;
    return h('li', props, header, list);
  }

  private renderRename(sectionId: string, current: string): HTMLElement {
    const input = h('input', { className: 'grn-rename', type: 'text', maxlength: '60', 'aria-label': 'Section name', 'data-focus': `section:${sectionId}|rename` });
    input.value = current;
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.ui.renaming = null;
      const name = input.value.trim();
      if (save && name && name !== current) void this.applyOps([{ type: 'renameSection', sectionId, name }], `Renamed section to ${name}.`, `section:${sectionId}|toggle`);
      else {
        this.pendingFocus = `section:${sectionId}|toggle`;
        this.queueRender();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return input;
  }

  private renderRepo(repo: RepoRecord, terms: string[], editable: boolean): HTMLElement {
    const menuOpen = this.ui.menu?.kind === 'repo' && this.ui.menu.repoId === repo.id;
    const signature = JSON.stringify([repo.owner, repo.name, repo.ownerAvatarUrl, repo.private, repo.visibility, repo.archived, terms, editable, menuOpen]);
    const cached = this.rowCache.get(repo.id);
    if (cached && cached.signature === signature) {
      cached.element.classList.remove('is-moved', 'is-dragging');
      return cached.element;
    }
    const element = this.buildRepoRow(repo, terms, editable);
    this.rowCache.set(repo.id, { signature, element });
    return element;
  }

  private buildRepoRow(repo: RepoRecord, terms: string[], editable: boolean): HTMLElement {
    const label = `${repo.owner}/${repo.name}`;
    const avatar = repo.ownerAvatarUrl ? h('img', { className: 'grn-avatar', src: repo.ownerAvatarUrl, alt: '', width: '16', height: '16', loading: 'lazy', draggable: 'false' }) : icon('repo');
    const badges: (HTMLElement | null)[] = [
      repo.private ? h('span', { className: 'grn-badge', title: repo.visibility === 'internal' ? 'Internal' : 'Private' }, icon('lock'), h('span', { className: 'sr-only' }, repo.visibility === 'internal' ? ' (internal)' : ' (private)')) : null,
      repo.archived ? h('span', { className: 'grn-badge', title: 'Archived' }, icon('archive'), h('span', { className: 'sr-only' }, ' (archived)')) : null,
    ];
    const link = h(
      'a',
      { className: 'grn-repo-link', href: repoUrl(repo), draggable: 'false', 'data-focus': `repo:${repo.id}|link`, 'data-repo-link': String(repo.id), title: label },
      avatar,
      h(
        'span',
        { className: 'grn-repo-text' },
        // Highlight against the whole "owner/name" (what the filter matches), then split it for styling.
        ...highlightRange(`${repo.owner}/${repo.name}`, terms, 0, repo.owner.length + 1).map((n) => wrap('grn-repo-owner', n)),
        ...highlightRange(`${repo.owner}/${repo.name}`, terms, repo.owner.length + 1),
      ),
      ...badges,
    );
    const menuButton = h(
      'button',
      {
        type: 'button',
        className: 'grn-icon-btn grn-row-menu',
        'aria-label': `Move ${label}`,
        title: 'Move repository',
        'aria-haspopup': 'menu',
        'aria-expanded': String(this.ui.menu?.kind === 'repo' && this.ui.menu.repoId === repo.id),
        'data-focus': `repo:${repo.id}|menu`,
        'data-menu-anchor': `repo:${repo.id}`,
      },
      icon('kebab-horizontal'),
    );
    menuButton.addEventListener('click', () => this.toggleMenu({ kind: 'repo', repoId: repo.id }));
    link.addEventListener('click', (event) => {
      // Same-tab navigation (GitHub turns it into a soft navigation): close the drawer once it is under way.
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      setTimeout(() => this.options.onNavigate?.(), 50);
    });
    const props: Record<string, string> = { className: 'grn-repo', 'data-repo-id': String(repo.id) };
    if (editable) props['data-drag-repo'] = String(repo.id);
    const grip = editable ? h('span', { className: 'grn-grip', 'data-grip': 'true', 'aria-hidden': 'true' }, icon('grabber')) : null;
    return h('li', props, grip, link, editable ? menuButton : null);
  }

  // ---------------------------------------------------------------- focus

  private pendingFocus: string | null = null;

  private captureFocus(): string | null {
    if (this.pendingFocus) {
      const f = this.pendingFocus;
      this.pendingFocus = null;
      return f;
    }
    const active = this.shadow.activeElement as HTMLElement | null;
    return active?.getAttribute('data-focus') ?? null;
  }

  private restoreFocus(key: string | null): void {
    if (!key) return;
    const target = [...this.frame.querySelectorAll<HTMLElement>('[data-focus]')].find((el) => el.getAttribute('data-focus') === key);
    if (target && this.shadow.activeElement !== target) target.focus({ preventScroll: false });
  }

  // ---------------------------------------------------------------- operations

  private async applyOps(ops: LayoutOp[], announcement: string, focusAfter?: string): Promise<void> {
    const state = this.state();
    if (!state || !this.editable(state)) {
      this.announce(state?.layout.sync.kind === 'readonly' ? state.layout.sync.reason : 'Sections cannot be edited right now.');
      return;
    }
    this.ui.notice = null;
    if (focusAfter) this.pendingFocus = focusAfter;
    const error = await this.store.apply(ops);
    this.announce(error ?? announcement);
  }

  announce(text: string): void {
    this.live.textContent = '';
    requestAnimationFrame(() => {
      this.live.textContent = text;
    });
  }

  private repoLabel(repoId: number): string {
    const repo = this.repoById.get(repoId);
    return repo ? `${repo.owner}/${repo.name}` : 'repository';
  }

  private sectionName(sectionId: string): string {
    return this.views.find((v) => v.section.id === sectionId)?.section.name ?? 'section';
  }

  private sectionOf(repoId: number): SectionView | undefined {
    return this.views.find((v) => v.repos.some((r) => r.id === repoId));
  }

  /** Visible repositories of a section after filtering (what keyboard moves are relative to). */
  private visibleRepos(view: SectionView): RepoRecord[] {
    const terms = matchTerms(this.ui.query);
    return view.repos.filter((r) => repoMatches(r, terms));
  }

  private dropRepo(repoId: number, target: RepoDropTarget): void {
    const view = this.views.find((v) => v.section.id === target.sectionId);
    if (!view) return;
    // Dropping a repository where it already is ("drag back to cancel") changes nothing.
    if (target.beforeRepoId === repoId) return;
    const current = this.sectionOf(repoId);
    if (current && current.section.id === target.sectionId) {
      if (target.sectionId === UNCATEGORIZED_ID) return;
      const position = current.repos.findIndex((r) => r.id === repoId);
      if ((current.repos[position + 1]?.id ?? null) === target.beforeRepoId) return;
    }
    this.ui.flash = repoId;
    void this.applyOps(
      [{ type: 'moveRepo', repoId, toSectionId: target.sectionId, beforeRepoId: target.beforeRepoId }],
      this.describeMove(repoId, target.sectionId, target.beforeRepoId),
      this.focusAfterMove(repoId, target.sectionId),
    );
  }

  /** Focus stays on the moved repository, or goes to its new section's header when that section is collapsed. */
  private focusAfterMove(repoId: number, sectionId: string): string {
    const destination = this.views.find((v) => v.section.id === sectionId);
    return destination?.section.collapsed && !matchTerms(this.ui.query).length ? `section:${sectionId}|toggle` : `repo:${repoId}|link`;
  }

  private describeMove(repoId: number, sectionId: string, before: number | null): string {
    const view = this.views.find((v) => v.section.id === sectionId);
    if (!view) return `Moved ${this.repoLabel(repoId)}.`;
    if (sectionId === UNCATEGORIZED_ID) return `Moved ${this.repoLabel(repoId)} to Uncategorized.`;
    const others = view.repos.filter((r) => r.id !== repoId);
    const index = before === null ? others.length : Math.max(0, others.findIndex((r) => r.id === before));
    const collapsed = view.section.collapsed ? ' The section is collapsed.' : '';
    return `Moved ${this.repoLabel(repoId)} to ${view.section.name}, position ${index + 1} of ${others.length + 1}.${collapsed}`;
  }

  /** Alt+Up / Alt+Down on a repository: one step, crossing into neighbouring sections at the edges. */
  moveRepoByKeyboard(repoId: number, direction: -1 | 1): void {
    const current = this.sectionOf(repoId);
    if (!current) return;
    const index = this.views.indexOf(current);
    const list = this.visibleRepos(current);
    const position = list.findIndex((r) => r.id === repoId);
    const automatic = current.section.id === UNCATEGORIZED_ID;
    let op: LayoutOp;
    if (!automatic && direction === -1 && position > 0) op = { type: 'moveRepo', repoId, toSectionId: current.section.id, beforeRepoId: list[position - 1]!.id };
    else if (!automatic && direction === 1 && position < list.length - 1) op = { type: 'moveRepo', repoId, toSectionId: current.section.id, beforeRepoId: list[position + 2]?.id ?? null };
    else {
      const neighbour = this.views[index + direction];
      if (!neighbour) {
        this.announce(direction === -1 ? `${this.repoLabel(repoId)} is already at the top.` : `${this.repoLabel(repoId)} is already at the bottom.`);
        return;
      }
      const target = this.visibleRepos(neighbour);
      op = { type: 'moveRepo', repoId, toSectionId: neighbour.section.id, beforeRepoId: direction === -1 ? null : (target[0]?.id ?? null) };
    }
    this.ui.flash = repoId;
    void this.applyOps([op], this.describeMove(repoId, op.toSectionId, op.beforeRepoId), this.focusAfterMove(repoId, op.toSectionId));
  }

  moveSectionByKeyboard(sectionId: string, direction: -1 | 1, focusRole = 'toggle'): void {
    const index = this.views.findIndex((v) => v.section.id === sectionId);
    if (index === -1) return;
    const target = index + direction;
    if (target < 0 || target >= this.views.length) {
      this.announce(`${this.sectionName(sectionId)} is already ${direction === -1 ? 'first' : 'last'}.`);
      return;
    }
    const before = direction === -1 ? this.views[target]!.section.id : (this.views[target + 1]?.section.id ?? null);
    void this.applyOps([{ type: 'moveSection', sectionId, beforeSectionId: before }], `Moved section ${this.sectionName(sectionId)} to position ${target + 1} of ${this.views.length}.`, `section:${sectionId}|${focusRole}`);
  }

  private tryDelete(sectionId: string): void {
    const state = this.state();
    if (!state) return;
    const guard = deleteGuard(state.layout.layout, sectionId, { inventory: new Set(state.inventory.repos.map((r) => r.id)) });
    if (!guard.allowed) {
      this.closeMenu(false);
      this.ui.notice = guard.message;
      this.announce(guard.message);
      this.queueRender();
      return;
    }
    const index = this.views.findIndex((v) => v.section.id === sectionId);
    const next = this.views[index + 1] ?? this.views[index - 1];
    void this.applyOps([{ type: 'deleteSection', sectionId }], `Deleted section ${this.sectionName(sectionId)}.`, next ? `section:${next.section.id}|toggle` : undefined);
  }

  startCreate(moveRepoId: number | null): void {
    const state = this.state();
    if (!state || !this.editable(state)) return;
    this.closeMenu(false);
    this.ui.creating = { moveRepoId };
    this.render();
  }

  startRename(sectionId: string): void {
    if (sectionId === UNCATEGORIZED_ID) {
      this.announce('Uncategorized cannot be renamed.');
      return;
    }
    this.closeMenu(false);
    this.ui.renaming = sectionId;
    this.render();
  }

  // ---------------------------------------------------------------- keyboard

  private focusables(): HTMLElement[] {
    return [...this.frame.querySelectorAll<HTMLElement>('[data-section-toggle], [data-repo-link]')].filter((el) => !el.closest('[hidden]'));
  }

  private onSearchKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.focusables()[0]?.focus();
    } else if (event.key === 'Enter') {
      const first = [...this.frame.querySelectorAll<HTMLAnchorElement>('[data-repo-link]')].find((a) => !a.closest('[hidden]'));
      if (first && this.ui.query.trim()) {
        event.preventDefault();
        first.click();
      }
    } else if (event.key === 'Escape' && this.search.value) {
      event.preventDefault();
      event.stopPropagation();
      this.search.value = '';
      this.ui.query = '';
      this.queueRender();
    }
  }

  private onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (this.drag.dragging) return;
    const repoId = target.getAttribute('data-repo-link');
    const sectionId = target.getAttribute('data-section-toggle');
    if (!repoId && !sectionId) return;
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    const direction = event.key === 'ArrowUp' ? -1 : 1;
    if (vertical && event.altKey) {
      event.preventDefault();
      const state = this.state();
      if (!state || !this.editable(state)) {
        this.announce('Sections cannot be edited right now.');
        return;
      }
      if (repoId) this.moveRepoByKeyboard(Number(repoId), direction);
      else if (sectionId) this.moveSectionByKeyboard(sectionId, direction);
      return;
    }
    if (vertical || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const items = this.focusables();
      const index = items.indexOf(target);
      const next = event.key === 'Home' ? items[0] : event.key === 'End' ? items[items.length - 1] : items[index + direction];
      next?.focus();
      return;
    }
    if (sectionId) {
      const view = this.views.find((v) => v.section.id === sectionId);
      if (!view) return;
      if ((event.key === 'ArrowLeft' && !view.section.collapsed) || (event.key === 'ArrowRight' && view.section.collapsed)) {
        event.preventDefault();
        if (!matchTerms(this.ui.query).length) void this.applyOps([{ type: 'setCollapsed', sectionId, collapsed: event.key === 'ArrowLeft' }], `${view.section.name} ${event.key === 'ArrowLeft' ? 'collapsed' : 'expanded'}.`);
      } else if (event.key === 'F2') {
        event.preventDefault();
        this.startRename(sectionId);
      } else if (event.key === 'Delete') {
        event.preventDefault();
        this.tryDelete(sectionId);
      }
    }
  }

  // ---------------------------------------------------------------- menus

  private toggleMenu(menu: Menu): void {
    const same = this.ui.menu && JSON.stringify(this.ui.menu) === JSON.stringify(menu);
    if (same) this.closeMenu(true);
    else this.openMenu(menu, true);
  }

  private onOutsidePointer = (event: PointerEvent): void => {
    if (!this.ui.menu) return;
    const path = event.composedPath();
    if (path.some((n) => n instanceof HTMLElement && (n.classList.contains('grn-menu') || n.hasAttribute('data-menu-anchor')))) return;
    this.closeMenu(false);
  };

  private closeMenu(focusAnchor: boolean): void {
    const menu = this.ui.menu;
    this.ui.menu = null;
    this.menuHost.replaceChildren();
    for (const el of this.frame.querySelectorAll('[data-menu-anchor][aria-expanded="true"]')) el.setAttribute('aria-expanded', 'false');
    if (menu && focusAnchor) {
      const key = menu.kind === 'repo' ? `repo:${menu.repoId}` : `section:${menu.sectionId}`;
      this.frame.querySelector<HTMLElement>(`[data-menu-anchor="${key}"]`)?.focus();
    }
    if (this.deferred) this.queueRender();
  }

  private openMenu(menu: Menu, focusFirst: boolean): void {
    const anchorKey = menu.kind === 'repo' ? `repo:${menu.repoId}` : `section:${menu.sectionId}`;
    const anchor = this.frame.querySelector<HTMLElement>(`[data-menu-anchor="${anchorKey}"]`);
    const state = this.state();
    if (!anchor || !state) {
      this.closeMenu(false);
      return;
    }
    this.ui.menu = menu;
    anchor.setAttribute('aria-expanded', 'true');
    const items = menu.kind === 'repo' ? this.repoMenuItems(menu.repoId) : this.sectionMenuItems(menu.sectionId, state);
    const list = h('div', { className: 'grn-menu', role: 'menu', 'aria-label': menu.kind === 'repo' ? `Move ${this.repoLabel(menu.repoId)}` : `Section ${this.sectionName(menu.sectionId)}` }, ...items);
    list.addEventListener('keydown', (e) => this.onMenuKey(e, list));
    // Like any menu, it closes when keyboard focus moves elsewhere.
    list.addEventListener('focusout', (e) => {
      const next = e.relatedTarget as Node | null;
      if (next && !list.contains(next) && this.ui.menu === menu) this.closeMenu(false);
    });
    const frameRect = this.frame.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    list.style.top = `${Math.round(rect.bottom - frameRect.top + 4)}px`;
    list.style.right = `${Math.max(4, Math.round(frameRect.right - rect.right))}px`;
    this.menuHost.replaceChildren(list);
    if (focusFirst) list.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }

  private onMenuKey(event: KeyboardEvent, list: HTMLElement): void {
    const items = [...list.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const index = items.indexOf(event.target as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const next = items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      next?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeMenu(true);
    } else if (event.key === 'Tab') {
      this.closeMenu(false);
    }
  }

  private menuItem(label: string, iconName: IconName | null, onSelect: (() => void) | null, hint?: string, danger = false): HTMLElement {
    // A focus key lets a background re-render (which rebuilds the open menu) keep keyboard focus on the same item.
    const props: Record<string, string | boolean> = { type: 'button', role: 'menuitem', className: `grn-menu-item${danger ? ' is-danger' : ''}`, tabindex: '-1', 'data-focus': `menu|${label}` };
    if (!onSelect) props['aria-disabled'] = 'true';
    const button = h('button', props, iconName ? icon(iconName) : h('span', { className: 'grn-icon' }), h('span', {}, h('span', { className: 'grn-menu-label' }, label), hint ? h('span', { className: 'grn-menu-hint' }, hint) : null));
    if (hint) button.setAttribute('aria-description', hint);
    button.addEventListener('click', (e) => {
      e.preventDefault();
      if (!onSelect) {
        if (hint) this.announce(hint);
        return;
      }
      this.closeMenu(false);
      onSelect();
    });
    return button;
  }

  private repoMenuItems(repoId: number): HTMLElement[] {
    const current = this.sectionOf(repoId);
    const items: HTMLElement[] = [
      this.menuItem('Move up', 'arrow-up', () => this.moveRepoByKeyboard(repoId, -1)),
      this.menuItem('Move down', 'arrow-down', () => this.moveRepoByKeyboard(repoId, 1)),
      h('div', { className: 'grn-menu-sep', role: 'separator' }),
      h('div', { className: 'grn-menu-heading', role: 'presentation' }, 'Move to section'),
    ];
    for (const view of this.views) {
      const isCurrent = view === current;
      const name = view.section.id === UNCATEGORIZED_ID ? `${view.section.name} (automatic)` : view.section.name;
      items.push(
        this.menuItem(
          name,
          isCurrent ? 'check' : 'file-directory',
          isCurrent
            ? null
            : () => {
                this.ui.flash = repoId;
                void this.applyOps([{ type: 'moveRepo', repoId, toSectionId: view.section.id, beforeRepoId: null }], this.describeMove(repoId, view.section.id, null), this.focusAfterMove(repoId, view.section.id));
              },
          isCurrent ? 'Current section' : undefined,
        ),
      );
    }
    items.push(this.menuItem('New section…', 'plus', () => this.startCreate(repoId)));
    return items;
  }

  private sectionMenuItems(sectionId: string, state: NavState): HTMLElement[] {
    const index = this.views.findIndex((v) => v.section.id === sectionId);
    const view = this.views[index];
    if (!view) return [];
    const automatic = sectionId === UNCATEGORIZED_ID;
    const guard = deleteGuard(state.layout.layout, sectionId, { inventory: new Set(state.inventory.repos.map((r) => r.id)) });
    return [
      this.menuItem('Rename', 'pencil', automatic ? null : () => this.startRename(sectionId), automatic ? 'Uncategorized is built in and keeps its name.' : undefined),
      this.menuItem('Move up', 'arrow-up', index > 0 ? () => this.moveSectionByKeyboard(sectionId, -1, 'menu') : null),
      this.menuItem('Move down', 'arrow-down', index < this.views.length - 1 ? () => this.moveSectionByKeyboard(sectionId, 1, 'menu') : null),
      this.menuItem(view.section.collapsed ? 'Expand' : 'Collapse', 'chevron-down', () =>
        void this.applyOps([{ type: 'setCollapsed', sectionId, collapsed: !view.section.collapsed }], `${view.section.name} ${view.section.collapsed ? 'expanded' : 'collapsed'}.`, `section:${sectionId}|menu`),
      ),
      h('div', { className: 'grn-menu-sep', role: 'separator' }),
      this.menuItem('Delete section', 'trash', guard.allowed ? () => this.tryDelete(sectionId) : null, guard.allowed ? undefined : guard.message, true),
    ];
  }

  // ---------------------------------------------------------------- drag geometry

  private repoTargets(): RepoDropItem[] {
    const items: RepoDropItem[] = [];
    for (const sectionEl of this.frame.querySelectorAll<HTMLElement>('.grn-section')) {
      const sectionId = sectionEl.getAttribute('data-section-id') ?? '';
      const automatic = sectionEl.hasAttribute('data-automatic');
      const header = sectionEl.querySelector<HTMLElement>('.grn-section-header');
      const list = sectionEl.querySelector<HTMLElement>('.grn-repos');
      const collapsed = !!list?.hidden;
      if (header) {
        const r = header.getBoundingClientRect();
        items.push({ kind: 'header', sectionId, top: r.top, bottom: r.bottom, collapsed, automatic });
      }
      if (!list || collapsed) continue;
      for (const row of list.children) {
        const r = (row as HTMLElement).getBoundingClientRect();
        const id = (row as HTMLElement).getAttribute('data-repo-id');
        items.push(id ? { kind: 'repo', sectionId, repoId: Number(id), top: r.top, bottom: r.bottom, collapsed, automatic } : { kind: 'empty', sectionId, top: r.top, bottom: r.bottom, collapsed, automatic });
      }
    }
    return items;
  }

  private sectionTargets(): SectionBox[] {
    return [...this.frame.querySelectorAll<HTMLElement>('.grn-section')].map((el) => {
      const r = el.getBoundingClientRect();
      return { sectionId: el.getAttribute('data-section-id') ?? '', top: r.top, bottom: r.bottom };
    });
  }
}

function wrap(className: string, node: Node): Node {
  const span = document.createElement('span');
  span.className = className;
  span.appendChild(node);
  return span;
}

/** Nearest scrollable ancestor of the host in the light DOM (the drawer's scroll area). */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return document.scrollingElement as HTMLElement | null;
}
