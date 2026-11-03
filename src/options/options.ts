import { h } from '../content/ui/dom';
import { CONFIG } from '../shared/config';
import { SYNC_TOTAL_QUOTA } from '../shared/layout/codec';
import type { LayoutOp } from '../shared/layout/model';
import { suggestSections, type SuggestedSection } from '../shared/layout/suggest';
import { chunkOps, exportSections, opsForPlan, parseSectionsFile, planImport, planSections, type PlanSection } from '../shared/layout/transfer';
import { isBroadcast, OPTIONS_TABS, type AccountSummary, type Diagnostics, type NavState, type OptionsTab, type Request, type Response } from '../shared/messages';
import { CLIENT_ID_RE, type AuthState, type RepoHint, type RepoId } from '../shared/types';
import {
  appFormFields,
  appSettingsUrl,
  clientIdProblem,
  defaultWizard,
  enterpriseCode,
  installUrl,
  isManagedLogin,
  MY_APPS_URL,
  orgAppsUrl,
  newAppUrl,
  NEW_APP_URL,
  ORG_RE,
  parseAppSlug,
  parseWizard,
  setupProgress,
  slugFor,
  startAdd,
  verifySlug,
  WIZARD_KEY,
  type AddAccount,
  type AppForm,
  type AppFormField,
  type SetupProgress,
  type SetupStep,
  type Wizard,
} from './setup';

const REVOKE_URL = 'https://github.com/settings/apps/authorizations';
const app = document.getElementById('app')!;
let diagnostics: Diagnostics | null = null;
let message: { text: string; kind: 'ok' | 'bad' } | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
/** What the user is typing survives re-renders triggered by background updates. */
let clientIdDraft: string | null = null;
let slugDraft: string | null = null;
/** False when the user restricted the extension's site access (chrome://extensions → Site access). */
let siteAccess = true;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

const wizard: Wizard = loadWizard();
/** Asking GitHub for each app's slug, by client ID (slug null: none of the guesses matched). Found ones go to wizard.slugs. */
const slugChecks = new Map<string, { slug: string | null; pending: boolean }>();
let lastAutoCheck = 0;
/**
 * The GitHub account this page shows (its repositories, sections and setup), by login: from the navigator that
 * opened it (?account=), or picked here. Undefined: the first connected account.
 */
let selectedAccount: string | undefined = new URLSearchParams(location.search).get('account') || undefined;
/**
 * The account a GitHub page asked for ("Connect @login too" opens this page with ?account=login). Not connected
 * yet, it is added instead of another account being shown in its place. Only the first load asks.
 */
let requestedAccount: string | undefined = selectedAccount;

/** The page is split into tabs instead of one long scroll. */
const TABS: { id: OptionsTab; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'organize', label: 'Organize' },
  { id: 'repositories', label: 'Repositories & sync' },
  { id: 'privacy', label: 'Privacy & advanced' },
];
const TAB_KEY = 'grn.options.tab';
/** From the URL (#organize, or #organize-suggest from the navigator's "Suggest sections"); null: choose on load. */
let activeTab: OptionsTab | null = tabFromHash();
/** Opened from the navigator's "Suggest sections": start the suggestion as soon as the repositories are known. */
let pendingSuggest = location.hash === '#organize-suggest';

function tabFromHash(): OptionsTab | null {
  const hash = location.hash.replace(/^#/, '').replace(/-suggest$/, '');
  return OPTIONS_TABS.find((t) => t === hash) ?? null;
}

/** Unfinished setup always opens on Setup; afterwards the last tab used. */
function defaultTab(d: Diagnostics): OptionsTab {
  if (wizard.add || setupProgress(d).step !== 'done') return 'setup';
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return OPTIONS_TABS.find((t) => t === saved) ?? 'setup';
  } catch {
    return 'setup';
  }
}

function selectTab(tab: OptionsTab, focus = false): void {
  activeTab = tab;
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage blocked: the tab still switches for this page view.
  }
  history.replaceState(null, '', `#${tab}`);
  render();
  window.scrollTo({ top: 0 });
  if (focus) document.getElementById(`tab-${tab}`)?.focus();
}

/** An inline link to another tab, for instructions that point elsewhere on the page. */
function tabLink(label: string, tab: OptionsTab): HTMLButtonElement {
  return button(label, () => selectTab(tab), 'link');
}

function loadWizard(): Wizard {
  try {
    return parseWizard(localStorage.getItem(WIZARD_KEY));
  } catch {
    return defaultWizard();
  }
}

function saveWizard(): void {
  try {
    localStorage.setItem(WIZARD_KEY, JSON.stringify(wizard));
  } catch {
    // Storage blocked: the guide still works for this page view.
  }
}

/** The account this page shows (null: none is connected). */
function shownAccount(d: Diagnostics): AccountSummary | null {
  return d.accounts.find((a) => a.userId === d.account) ?? null;
}

/** The GitHub App the shown account signs in through: its own, or the default one. */
function appOf(d: Diagnostics): string {
  return shownAccount(d)?.app ?? d.clientId.value;
}

/** An app's slug: from the build (for the build's own app), or confirmed against GitHub for its client ID. */
function slugOf(d: Diagnostics, clientId: string): string {
  if (!clientId) return '';
  if (d.appSlug && d.clientId.source === 'build' && clientId === d.clientId.value) return d.appSlug;
  return wizard.slugs[clientId] ?? slugChecks.get(clientId)?.slug ?? '';
}

/** The shown account's app's slug. */
function currentSlug(d: Diagnostics): string {
  return slugOf(d, appOf(d));
}

/** Finds an app's slug by asking GitHub which of the likely slugs (from names typed here, or `extra`) has its client ID. */
async function resolveSlug(d: Diagnostics, clientId: string, extra: string[] = []): Promise<void> {
  if (!clientId) return;
  slugChecks.set(clientId, { slug: null, pending: true });
  const named = [wizard.name, wizard.add?.form.name ?? ''].map(slugFor);
  const candidates = [...new Set([...extra, wizard.slug, ...named].filter(Boolean))];
  let found: string | null = null;
  for (const candidate of candidates) {
    if (await verifySlug(candidate, clientId, CONFIG.apiBase)) {
      found = candidate;
      break;
    }
  }
  slugChecks.set(clientId, { slug: found, pending: false });
  if (found && wizard.slugs[clientId] !== found) {
    wizard.slugs[clientId] = found;
    saveWizard();
  }
  render();
}

/**
 * Brings the guide's saved state up to date with the accounts connected: an older version's "hide the guide" goes to
 * the first account, and adding an account ends once it appears, showing that account. True: the shown account changed.
 */
function settleSetup(d: Diagnostics): boolean {
  if (wizard.hiddenLegacy) {
    wizard.hiddenLegacy = false;
    const first = d.accounts[0];
    if (first && !wizard.hidden.includes(first.userId)) wizard.hidden.push(first.userId);
    saveWizard();
  }
  const add = wizard.add;
  if (!add) return false;
  if (!d.accounts.length && add.had.length) {
    // Every account was disconnected meanwhile: this is a first setup now.
    wizard.add = null;
    saveWizard();
    return false;
  }
  const added = d.accounts.find((a) => !add.had.includes(a.userId));
  if (!added) return false;
  wizard.add = null;
  saveWizard();
  message = { text: `Connected ${added.login ? `@${added.login}` : 'the account'}. This page now shows it.`, kind: 'ok' };
  if (add.clientId && !slugOf(d, add.clientId)) void resolveSlug(d, add.clientId, [slugFor(add.form.name)]);
  if (!added.login || added.login === selectedAccount) return false;
  selectAccount(added.login);
  return true;
}

async function send<T>(request: Request): Promise<T> {
  const response = await chrome.runtime.sendMessage<Request, Response<T>>({ account: selectedAccount, ...request });
  if (!response?.ok) throw new Error(response?.error ?? 'No response from the extension.');
  return response.data;
}

async function reload(): Promise<void> {
  try {
    siteAccess = await chrome.permissions.contains({ origins: ['https://github.com/*', 'https://api.github.com/*'] });
  } catch {
    siteAccess = true;
  }
  try {
    diagnostics = await send<Diagnostics>({ type: 'diagnostics/get' });
    const known = diagnostics.accounts.some((a) => a.login?.toLowerCase() === selectedAccount?.toLowerCase());
    if (selectedAccount && !known && diagnostics.accounts.length) {
      // A GitHub page asked for an account that is not connected here: add it. Otherwise it was just disconnected.
      // Either way, show the first account meanwhile.
      if (requestedAccount && !wizard.add) {
        wizard.add = startAdd(diagnostics.accounts.map((a) => a.userId), requestedAccount);
        saveWizard();
        activeTab = 'setup';
      }
      selectAccount(undefined);
      diagnostics = await send<Diagnostics>({ type: 'diagnostics/get' });
    }
    requestedAccount = undefined;
    if (settleSetup(diagnostics)) diagnostics = await send<Diagnostics>({ type: 'diagnostics/get' });
  } catch (error) {
    message = { text: error instanceof Error ? error.message : String(error), kind: 'bad' };
  }
  render();
  const d = diagnostics;
  if (pendingSuggest && d && d.auth.kind === 'signed-in' && d.inventory.count > 0) {
    pendingSuggest = false;
    history.replaceState(null, '', '#organize');
    void startSuggest(d);
  }
  if (d) {
    for (const clientId of new Set([appOf(d), wizard.add?.clientId ?? ''])) {
      if (clientId && !slugOf(d, clientId) && !slugChecks.has(clientId)) void resolveSlug(d, clientId);
    }
  }
}

function selectAccount(login: string | undefined): void {
  selectedAccount = login;
  const url = new URL(location.href);
  if (login) url.searchParams.set('account', login);
  else url.searchParams.delete('account');
  history.replaceState(null, '', url);
}

/** With more than one account connected: which one this page shows. */
function accountPicker(d: Diagnostics): HTMLElement | null {
  const named = d.accounts.filter((a) => a.login);
  if (named.length < 2) return null;
  const select = h('select', { 'aria-label': 'GitHub account', 'data-key': 'account-picker' });
  for (const a of named) select.append(h('option', { value: a.login!, selected: a.userId === d.account }, `@${a.login}${a.kind === 'expired' ? ' (expired)' : ''}`));
  select.addEventListener('change', () => {
    selectAccount(select.value);
    message = null;
    void reload();
  });
  return h('label', { className: 'account-picker' }, 'Account ', select);
}

async function act(request: Request, success?: string): Promise<void> {
  try {
    await send(request);
    message = success ? { text: success, kind: 'ok' } : null;
  } catch (error) {
    message = { text: error instanceof Error ? error.message : String(error), kind: 'bad' };
  }
  await reload();
}

function button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const b = h('button', { type: 'button', className }, label);
  b.addEventListener('click', onClick);
  return b;
}

function link(label: string, href: string, className = ''): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', className }, label);
}

/** Copies what `text` returns when clicked (read then, so a value edited since render is copied as shown). */
function copyButton(text: () => string, label: string): HTMLButtonElement {
  const b = button('Copy', () => {
    void navigator.clipboard.writeText(text()).then(
      () => {
        b.textContent = 'Copied';
      },
      () => undefined,
    );
  }, 'small');
  b.setAttribute('aria-label', `Copy ${label}`);
  return b;
}

/** GitHub's new GitHub App form, field by field in the form's order, with what goes in each one. */
function appFormList(fields: AppFormField[]): HTMLElement {
  return h(
    'dl',
    { className: 'form-fields' },
    ...fields.map((field) => {
      const shown = field.copy !== undefined ? h('code', {}, field.copy) : null;
      return h(
        'div',
        { className: field.mustChange ? 'must' : null, 'data-field': field.id },
        h('dt', {}, field.label),
        h('dd', {}, shown ? h('span', { className: 'copy-line' }, shown, copyButton(() => shown.textContent ?? '', field.label)) : null, h('span', { className: shown ? 'muted' : null }, field.value)),
      );
    }),
  );
}

function when(at: number | null): string {
  if (!at) return 'never';
  return new Date(at).toLocaleString();
}

function countdown(expiresAt: number): string {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The device-flow code screen, shared by the setup guide and the connection card. */
/** `clientId`: the app being connected through (default: the shown account's). */
function authorizingBody(d: Diagnostics, auth: Extract<AuthState, { kind: 'authorizing' }>, clientId = appOf(d)): HTMLElement[] {
  const code = h('span', { className: 'code', 'aria-label': `Code ${auth.userCode.split('').join(' ')}` }, auth.userCode);
  const timer = h('span', { className: 'muted', id: 'countdown' }, `Code expires in ${countdown(auth.expiresAt)}.`);
  const copy = button('Copy code', () => {
    void navigator.clipboard.writeText(auth.userCode).then(
      () => {
        copy.textContent = 'Copied';
      },
      () => undefined,
    );
  });
  const slug = slugOf(d, clientId);
  return [
    h('p', {}, 'Enter this code on GitHub to finish connecting:'),
    h('div', { className: 'row' }, code),
    h('div', { className: 'row' }, button('Open github.com/login/device', () => window.open(auth.verificationUri, '_blank', 'noopener'), 'primary'), copy, button('Cancel', () => void act({ type: 'auth/cancel' }))),
    h(
      'ol',
      { className: 'substeps' },
      h('li', {}, 'Click ', h('strong', {}, 'Open github.com/login/device'), '. GitHub opens in a new tab.'),
      ...(d.accounts.length
        ? [h('li', {}, 'Check the avatar at the top of that page: GitHub connects the account it shows. To connect a different one, switch to it there (your avatar, ', h('strong', {}, 'Switch account'), ') first.')]
        : []),
      h('li', {}, 'Paste or type the code above and click ', h('strong', {}, 'Continue'), '.'),
      h('li', {}, 'GitHub shows the app’s name and “read-only access to metadata”. Click ', h('strong', {}, 'Authorize'), '.'),
      h('li', {}, 'Come back to this tab. It moves on by itself; there is nothing to click here.'),
    ),
    h('p', { className: 'row muted' }, timer, ' Waiting for GitHub…'),
    h(
      'p',
      { className: 'notice' },
      'Only enter a code that this page shows you. GitHub will ask you to authorize ',
      slug ? h('strong', {}, `the GitHub App "${slug}"`) : h('strong', {}, 'the GitHub App set up for this extension'),
      ' with read-only access to repository metadata. Check that the app name on GitHub is the one you created, and never enter a code someone sent you.',
    ),
  ];
}

/** Shown under a sign-in problem that needs a change on GitHub rather than another try. */
/** `adding`: the app chosen while adding an account, which is changed there rather than under Advanced. */
function problemFix(d: Diagnostics, adding?: AddAccount): HTMLElement {
  const clientId = adding ? adding.clientId : appOf(d);
  return h(
    'div',
    { className: 'fix' },
    h('p', {}, h('strong', {}, 'How to fix it:')),
    h(
      'ol',
      { className: 'substeps' },
      h('li', {}, 'Open ', link('your GitHub App’s settings', appSettingsUrl(adding ? adding.form : wizard, slugOf(d, clientId))), '. If you see a list of apps, click yours.'),
      h(
        'li',
        {},
        'Check that the ',
        h('strong', {}, 'Client ID'),
        ' near the top is exactly ',
        h('code', {}, clientId || '(none)'),
        adding ? '. If not, click Change above and pick or paste the right one.' : '. If not, paste the right one under Advanced at the bottom of this page.',
      ),
      h('li', {}, 'Scroll down to ', h('strong', {}, 'Identifying and authorizing users'), ', check ', h('strong', {}, 'Enable Device Flow'), ' and click ', h('strong', {}, 'Save changes'), ' at the bottom.'),
      h('li', {}, 'Come back here and click ', h('strong', {}, 'Connect GitHub'), ' again.'),
    ),
  );
}

function authCard(d: Diagnostics): HTMLElement {
  const card = h('section', { className: 'card', 'aria-labelledby': 'auth-title' }, h('h2', { id: 'auth-title' }, d.accounts.length > 1 ? 'GitHub accounts' : 'GitHub connection'));
  for (const account of d.accounts) {
    const who = account.login ? `@${account.login}` : 'this account';
    const disconnect = button('Disconnect', () => {
      if (confirm(`Disconnect ${who} on this device? Its sections stay synced; its cached repository list on this device is removed.`)) void act({ type: 'auth/signout', account: account.login ?? undefined }, `Disconnected ${who}.`);
    });
    const renews = account.kind === 'signed-in' && d.account === account.userId && d.auth.kind === 'signed-in' && d.auth.expiresAt ? ' The authorization renews itself automatically.' : '';
    const ownSlug = account.app ? slugOf(d, account.app) : '';
    const ownApp = account.app ? ` Signs in through its own GitHub App${ownSlug ? ` “${ownSlug}”` : ''}.` : '';
    const reconnect = button(`Reconnect ${who}`, () => void act({ type: 'auth/start', mode: 'reconnect', account: account.login ?? undefined }), 'primary');
    card.append(
      h(
        'div',
        { className: 'account-row' },
        h(
          'p',
          {},
          account.kind === 'signed-in' ? h('span', { className: 'ok' }, 'Connected') : h('span', { className: 'bad' }, 'Authorization expired'),
          account.login ? ` as @${account.login}.` : '.',
          account.kind === 'expired' ? ' Its saved list is still shown in the menu.' : renews,
          ownApp,
        ),
        h('div', { className: 'row' }, ...(account.kind === 'expired' && d.connect.kind !== 'authorizing' ? [reconnect] : []), disconnect),
      ),
    );
  }
  const connect = d.connect;
  // While an account is being added, its guide shows the code and any problem.
  if (!wizard.add) {
    if (connect.kind === 'authorizing') {
      card.append(...authorizingBody(d, connect));
    } else if (!d.accounts.length) {
      card.append(
        h('p', {}, 'Connect read-only access so the navigator can list every repository you can reach. GitHub will show a short code to confirm.'),
        h('div', { className: 'row' }, button('Connect GitHub', () => void act({ type: 'auth/start' }), 'primary')),
      );
    } else {
      card.append(
        h('div', { className: 'row' }, button('Add another account', () => beginAdd(d)), link('Revoke on GitHub', REVOKE_URL, 'button')),
        h(
          'p',
          { className: 'muted' },
          'Use more than one GitHub account, such as a personal one and a work one? Add each one; a guide walks through it. The navigator shows the repositories and sections of the account each GitHub page is signed in as.',
        ),
      );
    }
    if (connect.kind === 'signed-out' && connect.problem) card.append(h('p', { className: 'notice', role: 'alert' }, connect.problem.message), ...(connect.problem.restartable ? [] : [problemFix(d)]));
  }
  if (d.accounts.length) card.append(h('p', { className: 'muted' }, 'Each Chrome device connects separately; access tokens never leave this device.'));
  return card;
}

const STAGES: { step: SetupStep; title: string }[] = [
  { step: 'create', title: 'Create your GitHub App' },
  { step: 'connect', title: 'Connect this browser' },
  { step: 'install', title: 'Let the app see your repositories' },
  { step: 'done', title: 'Find your repositories on GitHub' },
];

/**
 * The setup guide: one checklist from "nothing" to "every repository in the menu". Each stage is checked
 * against real state (client ID saved, signed in, installation found with All repositories), so it cannot
 * be skipped by accident and it reappears if something later breaks.
 */
function setupCard(d: Diagnostics): HTMLElement | null {
  const progress = setupProgress(d);
  const current = STAGES.findIndex((s) => s.step === progress.step);
  if (isHidden(d) && (progress.step === 'done' || progress.step === 'install')) return null;
  const finished = progress.step === 'done';
  // With several accounts, say whose setup this is.
  const shownLogin = d.accounts.length > 1 ? shownAccount(d)?.login : null;
  const whose = shownLogin ? ` with @${shownLogin}` : '';
  const items = STAGES.map((stage, index) => {
    const state = index < current ? 'done' : index === current ? 'current' : 'todo';
    const title = stage.step === 'create' && wizard.path === 'existing' && state !== 'done' ? 'Use your existing GitHub App' : stage.title;
    const li = h('li', { className: `stage is-${state}`, 'aria-current': state === 'current' ? 'step' : null }, h('h3', {}, title, state === 'done' ? h('span', { className: 'sr-only' }, ' (done)') : null));
    if (state === 'done') li.append(h('p', { className: 'muted' }, stageSummary(d, stage.step)));
    if (state === 'current') li.append(...stageBody(d, stage.step, progress));
    return li;
  });
  return h(
    'section',
    { className: 'card setup', id: 'setup', 'aria-labelledby': 'setup-title' },
    h('h2', { id: 'setup-title' }, finished ? `You’re all set${whose}` : `Getting started${whose}`),
    h('p', { className: 'muted' }, finished ? 'Every step is done. Here is where to find everything.' : `Step ${current + 1} of ${STAGES.length}. ${current === 0 && wizard.path === null ? 'Setting up for the first time takes about three minutes; adding another browser takes under a minute.' : current === 0 && wizard.path === 'existing' ? 'Adding another browser takes under a minute.' : 'This page checks each step for you, so just follow along.'}`),
    h('ol', { className: 'wizard' }, ...items),
  );
}

function stageSummary(d: Diagnostics, step: SetupStep): string {
  switch (step) {
    case 'create': {
      const slug = currentSlug(d);
      return shownAccount(d)?.app
        ? `Signs in through its own GitHub App${slug ? ` “${slug}”` : ''} (client ID ${appOf(d)}).`
        : `Client ID ${d.clientId.value} saved${slug ? ` (app “${slug}”)` : ''}.`;
    }
    case 'connect':
      return d.auth.kind === 'signed-in' && d.auth.login ? `Signed in as @${d.auth.login}.` : 'Signed in.';
    case 'install':
      return isManagedLogin(shownAccount(d)?.login)
        ? `Installed on ${d.inventory.installations.filter((i) => !i.suspended).map((i) => i.account).join(', ')}.`
        : 'Installed on your account with All repositories.';
    case 'done':
      return '';
  }
}

function stageBody(d: Diagnostics, step: SetupStep, progress: SetupProgress): (Node | string)[] {
  switch (step) {
    case 'create':
      return createStage(d);
    case 'connect':
      return connectStage(d);
    case 'install':
      return installStage(d, progress);
    case 'done':
      return doneStage(d);
  }
}

function choosePath(path: Wizard['path']): void {
  wizard.path = path;
  saveWizard();
  message = null;
  render();
}

/** The guide was finished or skipped for the shown account. */
function isHidden(d: Diagnostics): boolean {
  return d.account !== null && wizard.hidden.includes(d.account);
}

/** Finishes (or skips) the guide for the shown account only; other accounts keep theirs. */
function hideGuide(d: Diagnostics): void {
  if (d.account !== null && !wizard.hidden.includes(d.account)) wizard.hidden.push(d.account);
  saveWizard();
  render();
}

/** Starts the "add another account" guide; `login` when a GitHub page asked for that account. */
function beginAdd(d: Diagnostics, login = ''): void {
  wizard.add = startAdd(
    d.accounts.map((a) => a.userId),
    login,
  );
  saveWizard();
  message = null;
  selectTab('setup');
}

function cancelAdd(): void {
  wizard.add = null;
  saveWizard();
  message = null;
  if (diagnostics?.connect.kind === 'authorizing') void act({ type: 'auth/cancel' });
  else render();
}

interface AppChoice {
  clientId: string;
  /** Logins of the accounts connected here that use it. */
  users: string[];
  isDefault: boolean;
}

/** The apps an added account can reuse: the default one, and each one some account uses as its own. */
function appChoices(d: Diagnostics): AppChoice[] {
  const choices = new Map<string, AppChoice>();
  if (d.clientId.value) choices.set(d.clientId.value, { clientId: d.clientId.value, users: d.accounts.flatMap((a) => (!a.app && a.login ? [a.login] : [])), isDefault: true });
  for (const own of d.ownApps) {
    const choice = choices.get(own.clientId) ?? { clientId: own.clientId, users: [], isDefault: false };
    if (own.login) choice.users.push(own.login);
    choices.set(own.clientId, choice);
  }
  return [...choices.values()];
}

function appLabel(choice: AppChoice): string {
  if (choice.users.length) return `The app ${choice.users.map((u) => `@${u}`).join(' and ')} ${choice.users.length > 1 ? 'use' : 'uses'}`;
  return choice.isDefault ? 'Your GitHub App' : 'The app another of your accounts uses';
}

/**
 * Adding another GitHub account: choose the app it signs in through (reuse one, or make a separate one), switch
 * github.com to it, connect. Once it appears the page shows it, and its own guide continues with installing.
 */
function addCard(d: Diagnostics): HTMLElement {
  const add = wizard.add!;
  const who = add.login ? `@${add.login}` : 'the account';
  const chosen = add.clientId !== '';
  const choice = appChoices(d).find((c) => c.clientId === add.clientId);
  const slug = slugOf(d, add.clientId);
  const change = button(
    'Change',
    () => {
      add.clientId = '';
      saveWizard();
      message = null;
      render();
    },
    'link',
  );
  const stages: { title: string; state: 'done' | 'current' | 'todo'; body: () => (Node | string)[] }[] = [
    {
      title: 'Choose its GitHub App',
      state: chosen ? 'done' : 'current',
      body: () => [h('p', { className: 'muted' }, choice ? `${appLabel(choice)}.` : `A separate app${slug ? ` “${slug}”` : ''}, client ID ${add.clientId}.`, ' ', change)],
    },
    { title: `Connect ${who}`, state: chosen ? 'current' : 'todo', body: () => addConnectStage(d, add) },
    { title: 'Let the app see its repositories', state: 'todo', body: () => [] },
  ];
  const items = stages.map((stage, index) => {
    const li = h('li', { className: `stage is-${stage.state}`, 'aria-current': stage.state === 'current' ? 'step' : null }, h('h3', {}, stage.title, stage.state === 'done' ? h('span', { className: 'sr-only' }, ' (done)') : null));
    if (stage.state === 'done') li.append(...stage.body());
    if (stage.state === 'current') li.append(...(index === 0 ? addAppStage(d, add) : stage.body()));
    return li;
  });
  return h(
    'section',
    { className: 'card setup', id: 'setup', 'aria-labelledby': 'setup-title' },
    h('h2', { id: 'setup-title' }, add.login ? `Add @${add.login}` : 'Add another GitHub account'),
    h('p', { className: 'muted' }, 'Each account keeps its own repositories and sections, and the navigator on github.com shows the one each page is signed in as.'),
    h('ol', { className: 'wizard' }, ...items),
    h('div', { className: 'row' }, button('Cancel', cancelAdd)),
  );
}

function addAppStage(d: Diagnostics, add: AddAccount): (Node | string)[] {
  const who = add.login ? `@${add.login}` : 'the account';
  if (add.separate) {
    return [
      h(
        'p',
        { className: 'notice' },
        h('strong', {}, `Sign in to github.com as ${who} first`),
        ' (your avatar at the top right, then ',
        h('strong', {}, 'Switch account'),
        ' or ',
        h('strong', {}, 'Add account'),
        '), so the new app belongs to that account.',
      ),
      ...newAppStage(d, add.form, 'add', isManagedLogin(add.login)),
      h(
        'p',
        { className: 'muted' },
        button(
          'Reuse an app instead',
          () => {
            add.separate = false;
            saveWizard();
            render();
          },
          'link',
        ),
      ),
    ];
  }
  const managed = isManagedLogin(add.login);
  const option = (key: string, title: string, text: string, onClick: () => void) => {
    const b = h('button', { type: 'button', className: 'path-option', 'data-key': key }, h('strong', {}, title), h('span', { className: 'muted' }, text));
    b.addEventListener('click', () => {
      message = null;
      onClick();
      saveWizard();
      render();
    });
    return b;
  };
  const reuse = appChoices(d).map((c) =>
    option(`add-app-${c.clientId}`, appLabel(c), c.isDefault ? 'Nothing to create: one app works for any number of personal accounts and organizations.' : `Client ID ${c.clientId}. Nothing to create.`, () => {
      add.clientId = c.clientId;
    }),
  );
  const separate = option(
    'add-app-separate',
    managed ? 'A separate app for this account (recommended)' : 'A separate app for this account',
    managed ? `Made while signed in as ${who}, so it counts as an app of the “${enterpriseCode(add.login)}” enterprise. About three minutes.` : 'Only needed when an enterprise or organization wants its own app, as some work accounts do. About three minutes.',
    () => {
      add.separate = true;
    },
  );
  return [
    h(
      'p',
      {},
      managed
        ? `${who} is a managed account of the “${enterpriseCode(add.login)}” enterprise. Its organizations’ owners decide which apps may be installed there, and some enterprises allow only apps made inside them. A separate app made while signed in as ${who} is the safer choice; reusing yours works where the owners allow it.`
        : 'Every account signs in through a GitHub App. One app works for any number of accounts, so reusing yours is the quick way.',
    ),
    h('div', { className: 'path-options' }, ...(managed ? [separate, ...reuse] : [...reuse, separate])),
    ...(add.login
      ? []
      : [h('p', { className: 'muted' }, 'Adding a work account whose name ends in an underscore and a short code, like mona-lisa_acme? That is a managed account of a company’s enterprise: a separate app is the safer choice.')]),
  ];
}

function addConnectStage(d: Diagnostics, add: AddAccount): (Node | string)[] {
  const connect = d.connect;
  if (connect.kind === 'authorizing') return authorizingBody(d, connect, add.clientId);
  const who = add.login ? `@${add.login}` : 'the account you are adding';
  const nodes: (Node | string)[] = [
    h('p', {}, 'GitHub connects whichever account is signed in on github.com, so switch to it there first.'),
    h(
      'ol',
      { className: 'substeps' },
      h('li', {}, 'On github.com, click your avatar at the top right, then ', h('strong', {}, 'Switch account'), ` and pick ${who}. Not listed? Choose `, h('strong', {}, 'Add account'), ' and sign in to it; your other account stays signed in.'),
      h('li', {}, 'Come back to this tab and click ', h('strong', {}, 'Connect this account'), '. This page then shows a code to enter on GitHub.'),
    ),
    h('div', { className: 'row' }, button('Connect this account', () => void act({ type: 'auth/start', mode: 'add', clientId: add.clientId }), 'primary')),
  ];
  if (connect.kind === 'signed-out' && connect.problem) {
    nodes.push(h('p', { className: 'notice', role: 'alert' }, connect.problem.message));
    if (!connect.problem.restartable) nodes.push(problemFix(d, add));
  }
  return nodes;
}

/**
 * First step, before anything about creating an app: is this a first setup, or another browser for someone who
 * already has a GitHub App? The client ID syncs through Chrome Sync, so a browser on the same Chrome profile
 * usually never sees this step at all.
 */
function createStage(d: Diagnostics): (Node | string)[] {
  if (wizard.path === 'existing') return existingAppStage(d);
  if (wizard.path === 'new') return [...newAppStage(d, wizard, 'default'), h('p', { className: 'muted' }, button('I already set this up in another browser', () => choosePath('existing'), 'link'))];
  const option = (path: 'new' | 'existing', title: string, text: string) => {
    const b = h('button', { type: 'button', className: 'path-option', 'data-key': `path-${path}` }, h('strong', {}, title), h('span', { className: 'muted' }, text));
    b.addEventListener('click', () => choosePath(path));
    return b;
  };
  return [
    h('p', {}, 'The extension signs in through a small GitHub App that you own (read-only, no password, secret or server). Which describes you?'),
    h(
      'div',
      { className: 'path-options' },
      option('new', 'This is my first time', 'Create your GitHub App: GitHub’s form opens already filled in. About three minutes, once.'),
      option('existing', 'I already use Repo Navigator in another browser', 'Reuse your GitHub App: copy its client ID, then connect. Under a minute.'),
    ),
    h(
      'p',
      { className: 'muted' },
      'Using Chrome Sync on the same Chrome profile as your other browser? Your client ID and sections arrive on their own, usually within a minute, and this step completes by itself.',
    ),
  ];
}

/** Another browser for someone who already created the app: find its client ID on GitHub, paste, connect. */
function existingAppStage(d: Diagnostics): (Node | string)[] {
  const orgInput = h('input', { type: 'text', placeholder: 'organization-login', 'aria-label': 'Organization that owns the app', spellcheck: 'false', autocomplete: 'off', 'data-key': 'existing-org' });
  orgInput.value = wizard.owner === 'org' ? wizard.org : '';
  const openOrgApps = () => {
    const org = orgInput.value.trim();
    if (!ORG_RE.test(org)) {
      message = { text: 'Type the organization’s login as it appears in its URL, e.g. "my-company" for github.com/my-company.', kind: 'bad' };
      render();
      return;
    }
    window.open(orgAppsUrl(org), '_blank', 'noopener');
  };
  return [
    h('p', {}, 'Your GitHub App already exists, so there is nothing to create: this browser only needs its client ID, then you connect.'),
    h(
      'ol',
      { className: 'substeps' },
      h(
        'li',
        {},
        h('p', {}, h('strong', {}, 'Open your GitHub Apps.'), ' Make sure you are signed in to GitHub in this browser.'),
        h('div', { className: 'row' }, link('Open my GitHub Apps', MY_APPS_URL, 'button primary')),
        h(
          'details',
          { className: 'guide', 'data-key': 'existing-org-apps' },
          h('summary', {}, 'The app belongs to an organization'),
          h('div', { className: 'row' }, h('label', { className: 'field' }, 'Organization login', orgInput), button('Open its GitHub Apps', openOrgApps)),
        ),
      ),
      h('li', {}, h('p', {}, h('strong', {}, 'Click your Repo Navigator app'), ' (named like “Repo Navigator a1b2c”, unless you renamed it) and copy the value next to ', h('strong', {}, 'Client ID'), ' near the top. It starts with ', h('code', {}, 'Iv'), '.')),
      h('li', {}, h('p', {}, h('strong', {}, 'Paste it here.')), clientIdForm(d, 'client-id-existing')),
    ),
    h('p', { className: 'muted' }, 'Also shown in your other browser: Repo Navigator settings → Privacy & advanced → Advanced → Copy client ID.'),
    h('p', { className: 'muted' }, button('I don’t have an app yet: set one up', () => choosePath('new'), 'link')),
  ];
}

/** Creating a GitHub App through GitHub's pre-filled form: the first one (default), or one for an account being added. */
/** `managed`: made by a managed account, whose app GitHub limits to its enterprise. */
function newAppStage(d: Diagnostics, form: AppForm, target: ClientIdTarget, managed = false): (Node | string)[] {
  const ownerRadio = (value: Wizard['owner'], label: string) => {
    const input = h('input', { type: 'radio', name: 'wizard-owner', value, checked: form.owner === value, 'data-key': `wizard-owner-${value}` });
    input.addEventListener('change', () => {
      form.owner = value;
      saveWizard();
      render();
    });
    return h('label', { className: 'choice' }, input, label);
  };
  const orgInput = h('input', { type: 'text', placeholder: 'organization-login', 'aria-label': 'Organization login', spellcheck: 'false', autocomplete: 'off', 'data-key': 'wizard-org' });
  orgInput.value = form.org;
  orgInput.addEventListener('input', () => {
    form.org = orgInput.value;
    saveWizard();
  });
  const fields = appFormList(appFormFields(form, managed));
  const nameInput = h('input', { type: 'text', maxlength: 34, 'aria-label': 'GitHub App name', spellcheck: 'false', autocomplete: 'off', 'data-key': 'wizard-name' });
  nameInput.value = form.name;
  nameInput.addEventListener('input', () => {
    form.name = nameInput.value;
    saveWizard();
    // The field list repeats the name; keep it in step without a re-render (which would steal focus).
    const shown = fields.querySelector('[data-field="name"] code');
    if (shown) shown.textContent = form.name.trim();
  });
  const openForm = () => {
    if (!form.name.trim()) {
      message = { text: 'Give the app a name first.', kind: 'bad' };
      render();
      return;
    }
    if (form.owner === 'org' && !ORG_RE.test(form.org.trim())) {
      message = { text: 'Type the organization’s login as it appears in its URL, e.g. "my-company" for github.com/my-company.', kind: 'bad' };
      render();
      return;
    }
    form.org = form.org.trim();
    saveWizard();
    message = null;
    window.open(newAppUrl(form), '_blank', 'noopener');
  };
  return [
    h('p', {}, 'The extension signs in through a small GitHub App that you own. It can only read repository names and similar metadata. No password, secret or server is involved.'),
    h(
      'ol',
      { className: 'substeps' },
      h(
        'li',
        {},
        h('p', {}, h('strong', {}, 'Open GitHub’s form, already filled in.'), ' Make sure you are signed in to GitHub in this browser, then choose who will own the app:'),
        h('div', { className: 'row' }, ownerRadio('user', 'My personal account'), ownerRadio('org', 'An organization I own')),
        form.owner === 'org'
          ? h('div', {}, h('div', { className: 'row' }, h('label', { className: 'field' }, 'Organization login', orgInput)), h('p', { className: 'muted' }, 'You must be an owner of the organization. If you are not, choose your personal account; the app can still be installed on the organization later.'))
          : null,
        h('div', { className: 'row' }, h('label', { className: 'field' }, 'App name', nameInput)),
        h('p', { className: 'muted' }, 'App names are unique across all of GitHub, so this one has a random ending. Any name works.'),
        h('div', { className: 'row' }, button('Open the pre-filled form on GitHub', openForm, 'primary')),
      ),
      h(
        'li',
        {},
        h(
          'p',
          {},
          h('strong', {}, 'On GitHub, check the form, tick Enable Device Flow, and create.'),
          ' The form should open filled in, so usually that one box is the only change. If a field is empty or different, set it as shown here. The fields are in the same order as on GitHub’s page:',
        ),
        fields,
        h(
          'ul',
          { className: 'plain' },
          h('li', {}, 'Then scroll to the very bottom and click ', h('strong', {}, 'Create GitHub App'), '.'),
          h('li', {}, 'If GitHub says the name is taken, change the name above and open the form again.'),
        ),
      ),
      h(
        'li',
        {},
        h('p', {}, h('strong', {}, 'Copy the Client ID and paste it here.'), ' After you click Create, GitHub shows your new app’s page. Near the top, copy the value next to ', h('strong', {}, 'Client ID'), ' (it starts with ', h('code', {}, 'Iv'), ').'),
        h('p', { className: 'notice' }, 'Do not click “Generate a new client secret” or “Generate a private key”. This extension never needs them, and you should never paste a secret here.'),
        clientIdForm(d, target === 'add' ? 'client-id-add' : 'client-id-setup', target),
      ),
    ),
    h('p', { className: 'muted' }, 'Already have a GitHub App with Device Flow enabled and Metadata: Read-only? Just paste its client ID above.'),
  ];
}

function connectStage(d: Diagnostics): (Node | string)[] {
  const auth = d.auth;
  if (auth.kind === 'authorizing') return authorizingBody(d, auth);
  const reconnect = auth.kind === 'expired';
  const nodes: (Node | string)[] = [
    h('p', {}, 'Now let this browser sign in through your app. Click the button, and this page shows a short code to enter on GitHub. It takes about 20 seconds.'),
    h('div', { className: 'row' }, button(reconnect ? 'Reconnect GitHub' : 'Connect GitHub', () => void act(reconnect ? { type: 'auth/start', mode: 'reconnect' } : { type: 'auth/start' }), 'primary')),
    h('p', { className: 'muted' }, 'If an organization uses SAML single sign-on, sign in to it on github.com first so its repositories are included.'),
  ];
  // Another browser connects some account through its own app (Chrome Sync says so): that app can be picked here too.
  if (!reconnect && d.ownApps.length) nodes.push(h('p', { className: 'muted' }, 'Connecting an account that uses its own GitHub App on your other browsers? ', button('Pick its app', () => beginAdd(d), 'link')));
  if (auth.kind === 'signed-out' && auth.problem) {
    nodes.push(h('p', { className: 'notice', role: 'alert' }, auth.problem.message));
    if (!auth.problem.restartable) nodes.push(problemFix(d));
  }
  return nodes;
}

/** Recheck right away when the user comes back from GitHub, so they never have to find a refresh button. */
function autoCheck(): void {
  const d = diagnostics;
  if (!d || document.visibilityState !== 'visible') return;
  if (setupProgress(d).step !== 'install' || d.inventory.status.kind === 'refreshing') return;
  if (Date.now() - lastAutoCheck < 5000) return;
  lastAutoCheck = Date.now();
  void act({ type: 'inventory/refresh', force: true });
}

function installStage(d: Diagnostics, progress: SetupProgress): (Node | string)[] {
  const login = d.auth.kind === 'signed-in' ? d.auth.login : null;
  const who = login ? `@${login}` : 'your account';
  if (progress.checking) return [h('p', {}, h('span', { className: 'spinner', 'aria-hidden': 'true' }), ' Checking which accounts the app can see…')];
  const checkAgain = button('Check again', () => void act({ type: 'inventory/refresh', force: true }));
  const own = progress.own;
  if (own) {
    // Installed, but limited to hand-picked repositories.
    return [
      h('p', { className: 'notice' }, `The app is installed on ${who}, but only for selected repositories, so the menu is missing the rest (showing ${plural(d.inventory.count, 'repository', 'repositories')}).`),
      h(
        'ol',
        { className: 'substeps' },
        h('li', {}, 'Click ', h('strong', {}, 'Change repository access'), '. GitHub opens the app’s installation settings.'),
        h('li', {}, 'Under ', h('strong', {}, 'Repository access'), ', choose ', h('strong', {}, 'All repositories'), '.'),
        h('li', {}, 'Click ', h('strong', {}, 'Save'), ', then come back to this tab. It checks again automatically.'),
      ),
      h('div', { className: 'row' }, own.settingsUrl ? link('Change repository access', own.settingsUrl, 'button primary') : link('Open installed apps', 'https://github.com/settings/installations', 'button primary'), checkAgain),
      skipLine(d, 'Only need repositories from organizations, not your own? '),
    ];
  }
  if (login && isManagedLogin(login)) return managedInstallStage(d, login, checkAgain);
  return [
    h(
      'p',
      { className: 'notice' },
      `You are connected, but the app is not installed on ${who} yet. Until it is, GitHub only lets it see your public repositories (${plural(d.inventory.count, 'repository', 'repositories')} so far).`,
    ),
    h(
      'ol',
      { className: 'substeps' },
      h('li', {}, 'Click ', h('strong', {}, 'Install the app on GitHub'), '.'),
      h('li', {}, 'If GitHub asks where to install it, pick ', h('strong', {}, login ?? 'your personal account'), '.'),
      h('li', {}, 'Choose ', h('strong', {}, 'All repositories'), ' (not “Only select repositories”), so new repositories show up too.'),
      h('li', {}, 'Click ', h('strong', {}, 'Install'), ', then come back to this tab. It checks again automatically.'),
    ),
    ...installLinks(d, checkAgain),
    skipLine(d, 'Only need repositories from organizations, not your own? '),
  ];
}

/**
 * A managed account (Enterprise Managed Users): GitHub never lets one install an app on itself, so the app goes on the
 * enterprise's organizations (or, for a repository admin, chosen repositories). Any installation finishes setup.
 */
function managedInstallStage(d: Diagnostics, login: string, checkAgain: HTMLButtonElement): (Node | string)[] {
  const who = `@${login}`;
  return [
    h(
      'p',
      { className: 'notice' },
      `${who} is a managed account of the “${enterpriseCode(login)}” enterprise. GitHub does not let managed accounts install apps on themselves, so the app goes on the enterprise’s organizations instead. Until it is on at least one, their repositories cannot be listed (${plural(d.inventory.count, 'repository', 'repositories')} so far).`,
    ),
    h(
      'ol',
      { className: 'substeps' },
      h('li', {}, 'Make sure github.com is signed in as ', h('strong', {}, who), ', then click ', h('strong', {}, 'Install the app on GitHub'), '.'),
      h('li', {}, h('strong', {}, 'An organization you own:'), ' pick it, choose ', h('strong', {}, 'All repositories'), ' and click ', h('strong', {}, 'Install'), '.'),
      h(
        'li',
        {},
        h('strong', {}, 'Any other organization:'),
        ' pick it and click ',
        h('strong', {}, 'Request'),
        '. GitHub asks its owners to approve, and the repositories appear here once they do. If you are an admin of some of its repositories, GitHub may instead let you install it on just those.',
      ),
      h('li', {}, 'Come back to this tab. It checks again automatically.'),
    ),
    ...installLinks(d, checkAgain),
    ...(shownAccount(d)?.app
      ? []
      : [
          h(
            'p',
            { className: 'muted' },
            `GitHub lists none of the enterprise’s organizations, or an owner turns the request down? Some enterprises allow only apps made inside them. Disconnect ${who} below, then add it again and choose “A separate app for this account”, making it while signed in as ${who}.`,
          ),
        ]),
    skipLine(d, 'Only need repositories that are already listed? '),
  ];
}

function skipLine(d: Diagnostics, text: string): HTMLElement {
  return h('p', { className: 'muted' }, text, button('Skip this step', () => hideGuide(d), 'link'));
}

/** The install button, or (the app's address unknown) a way to find the app first. */
function installLinks(d: Diagnostics, checkAgain: HTMLButtonElement): HTMLElement[] {
  const app = appOf(d);
  const slug = currentSlug(d);
  if (slug) return [h('div', { className: 'row' }, link('Install the app on GitHub', installUrl(slug), 'button primary'), checkAgain)];
  if (slugChecks.get(app)?.pending) return [h('p', { className: 'muted' }, h('span', { className: 'spinner', 'aria-hidden': 'true' }), ' Finding your app on GitHub…')];
  // The app was named or renamed on GitHub, so its address is unknown. Ask for it once; it is verified.
  const input = h('input', { type: 'text', placeholder: 'https://github.com/settings/apps/your-app', 'aria-label': 'Your GitHub App’s address', spellcheck: 'false', autocomplete: 'off', 'data-key': 'slug-input' });
  input.value = slugDraft ?? '';
  input.addEventListener('input', () => {
    slugDraft = input.value;
  });
  const find = () => {
    const slug = parseAppSlug(input.value);
    if (!slug) {
      message = { text: 'Paste the address from your browser’s address bar while your app’s page is open on GitHub. It looks like github.com/settings/apps/your-app.', kind: 'bad' };
      render();
      return;
    }
    slugDraft = null;
    message = null;
    void resolveSlug(d, app, [slug]).then(() => {
      if (!slugOf(d, app)) {
        message = { text: `GitHub has no app “${slug}” with client ID ${app}. Check that you copied the address of the same app whose client ID you saved.`, kind: 'bad' };
        render();
      }
    });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') find();
  });
  return [
    h(
      'div',
      { className: 'fix' },
      h('p', {}, 'First, this page needs your app’s address (the name was changed on GitHub, so it cannot guess it):'),
      h(
        'ol',
        { className: 'substeps' },
        h('li', {}, 'Open ', link('your GitHub Apps', appSettingsUrl(wizard, '')), ' and click your app’s name.'),
        h('li', {}, 'Copy the address from the browser’s address bar and paste it here.'),
      ),
      h('div', { className: 'row' }, input, button('Find my app', find, 'primary')),
    ),
    h('div', { className: 'row' }, checkAgain),
  ];
}

function doneStage(d: Diagnostics): (Node | string)[] {
  const slug = currentSlug(d);
  const install = slug ? installUrl(slug) : null;
  const accounts = d.inventory.installations.filter((i) => !i.suspended).map((i) => i.account);
  const share = install
    ? button('Copy install link', () => {
        void navigator.clipboard.writeText(install).then(
          () => {
            message = { text: 'Install link copied. Send it to the account’s owner.', kind: 'ok' };
            render();
          },
          () => undefined,
        );
      })
    : null;
  return [
    h('p', { className: 'ok' }, `${plural(d.inventory.count, 'repository', 'repositories')} ready${accounts.length ? ` from ${accounts.join(', ')}` : ''}.`),
    h(
      'ol',
      { className: 'substeps' },
      h('li', {}, 'Open ', link('github.com', 'https://github.com/'), ' (any page).'),
      h('li', {}, 'Click the ', h('strong', {}, '☰ menu button'), ' at the very top-left, next to the GitHub logo. A side menu slides out.'),
      h('li', {}, 'Its ', h('strong', {}, 'Top repositories'), ' section now lists every repository, with a filter box. The list on the dashboard’s left side is replaced the same way.'),
      h('li', {}, 'To organize: on the ', tabLink('Organize', 'organize'), ' tab, click ', h('strong', {}, 'Suggest sections'), ' to get a ready-made set you can edit, or click ', h('strong', {}, '+'), ' (New section) at the top of the list and drag repositories in. Sections sync to your other Chrome devices.'),
    ),
    h('div', { className: 'row' }, link('Open GitHub', 'https://github.com/', 'button primary')),
    h('h3', {}, 'Repositories in organizations or other people’s accounts'),
    h('p', {}, 'Those appear only once the app is installed on that account too.'),
    h(
      'ul',
      { className: 'plain' },
      h('li', {}, h('strong', {}, 'An organization you own:'), ' click ', install ? link('Install on another account', install) : h('strong', {}, 'Install App on your app’s GitHub page'), ', pick the organization, choose All repositories, Install. Then click Refresh now on the ', tabLink('Repositories & sync', 'repositories'), ' tab.'),
      h('li', {}, h('strong', {}, 'An account you do not own:'), ' send its owner the install link and ask them to install it with All repositories (or at least the repositories you work on). ', share ?? ''),
    ),
    h(
      'div',
      { className: 'row' },
      button('Hide this guide', () => hideGuide(d)),
    ),
  ];
}

/** Step-by-step GitHub App setup, mirroring the README's "Set up the GitHub App (once)" section. */
function clientIdGuide(key: string, summary: string): HTMLElement {
  const step = (...children: (Node | string)[]) => h('li', {}, ...children);
  return h(
    'details',
    { className: 'guide', 'data-key': key },
    h('summary', {}, summary),
    h('p', { className: 'muted' }, 'Do this once. Everyone who uses this build can share the same app, and the client ID is not a secret.'),
    h(
      'ol',
      {},
      step('Open ', link('GitHub → Settings → Developer settings → GitHub Apps → New GitHub App', NEW_APP_URL), '. To have an organization own the app, start from that organization’s settings instead.'),
      step('Fill in the form, top to bottom:', appFormList(appFormFields(wizard))),
      step('Click ', h('strong', {}, 'Create GitHub App'), ', then copy the ', h('strong', {}, 'Client ID'), ' (it starts with ', h('code', {}, 'Iv'), '). Do not generate a client secret or private key; they are not used.'),
      step('On the app’s page, choose ', h('strong', {}, 'Install App'), ' and install it on your account and on every organization whose repositories you want listed, with ', h('strong', {}, 'All repositories'), '.'),
      step('Paste the client ID below and choose ', h('strong', {}, 'Save client ID'), ', then ', h('strong', {}, 'Connect GitHub'), '.'),
    ),
  );
}

/** Where a pasted client ID goes: the default app (synced to every browser), or the app of the account being added. */
type ClientIdTarget = 'default' | 'add';

function clientIdForm(d: Diagnostics, key: string, target: ClientIdTarget = 'default'): HTMLElement {
  const input = h('input', { type: 'text', placeholder: 'Iv23li…', 'aria-label': 'GitHub App client ID', spellcheck: 'false', autocomplete: 'off', 'data-key': key });
  input.value = clientIdDraft ?? (target === 'default' && d.clientId.source === 'options' ? d.clientId.value : '');
  input.addEventListener('input', () => {
    clientIdDraft = input.value;
  });
  const save = () => {
    const value = input.value.trim();
    if (!value) {
      message = { text: 'Paste the GitHub App client ID first.', kind: 'bad' };
      render();
      return;
    }
    // The background checks the default app's ID itself; the added account's is only used once it connects.
    const problem = clientIdProblem(value) ?? (target === 'add' && !CLIENT_ID_RE.test(value) ? 'That does not look like a GitHub App client ID. Copy the value next to “Client ID” near the top of the app’s page (it starts with “Iv”).' : null);
    if (problem) {
      message = { text: problem, kind: 'bad' };
      render();
      return;
    }
    clientIdDraft = null;
    if (target === 'add') {
      if (!wizard.add) return;
      wizard.add.clientId = value;
      saveWizard();
      message = { text: 'Client ID saved for this account. Next, connect it.', kind: 'ok' };
      render();
      void resolveSlug(d, value);
      return;
    }
    void act({ type: 'config/set-client-id', clientId: value }, 'Client ID saved.');
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
  return h(
    'div',
    { className: 'row' },
    input,
    button('Save client ID', save, 'primary'),
    target === 'default' && d.clientId.source === 'options' ? button('Use build default', () => void act({ type: 'config/set-client-id', clientId: '' }, 'Using the build default.')) : null,
  );
}

function inventoryCard(d: Diagnostics): HTMLElement {
  const inv = d.inventory;
  const status = inv.status;
  const statusText =
    status.kind === 'refreshing'
      ? 'Refreshing…'
      : status.kind === 'rate-limited'
        ? `Rate limited until ${new Date(status.resetAt).toLocaleTimeString()}`
        : status.kind === 'offline'
          ? 'GitHub unreachable (showing the saved list)'
          : status.kind === 'error'
            ? status.message
            : 'Up to date';
  const slug = currentSlug(d);
  const install = slug ? installUrl(slug) : null;
  const card = h(
    'section',
    { className: 'card', 'aria-labelledby': 'inv-title' },
    h('h2', { id: 'inv-title' }, 'Repositories'),
    h(
      'dl',
      { className: 'facts' },
      h('dt', {}, 'Repositories'),
      h('dd', {}, String(inv.count)),
      h('dt', {}, 'Last refresh'),
      h('dd', {}, when(inv.fetchedAt)),
      h('dt', {}, 'Status'),
      h('dd', {}, statusText),
      h('dt', {}, 'API pages read'),
      h('dd', {}, inv.pages ? `${inv.pages} (${inv.notModifiedPages} unchanged, served from cache)` : '—'),
      h('dt', {}, 'Rate limit'),
      h('dd', {}, inv.rateLimit.remaining !== null ? `${inv.rateLimit.remaining} of ${inv.rateLimit.limit ?? '?'} requests left this hour` : '—'),
    ),
    h('div', { className: 'row' }, button('Refresh now', () => void act({ type: 'inventory/refresh', force: true }, 'Refresh started.')), install ? link('Install on another account or organization', install, 'button') : null),
  );
  const coverage = h('div', {}, h('h3', {}, 'Accounts the app can see'));
  if (inv.installations.length) {
    coverage.append(
      h(
        'ul',
        { className: 'plain' },
        ...inv.installations.map((i) =>
          h(
            'li',
            {},
            `${i.account} (${i.accountType}) — ${i.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}${i.suspended ? ', suspended' : ''} `,
            i.settingsUrl ? link('change access', i.settingsUrl) : null,
          ),
        ),
      ),
    );
  } else {
    coverage.append(h('p', { className: 'muted' }, d.auth.kind === 'signed-in' ? 'No installations yet. Install the app on your account and organizations to see their private repositories.' : 'Connect GitHub to see coverage.'));
  }
  coverage.append(
    h('p', { className: 'muted' }, 'GitHub Apps only see repositories on accounts where the app is installed. Install it on your personal account and on each organization (or ask an owner) to include their private repositories.'),
  );
  for (const issue of inv.installationIssues) coverage.append(h('p', { className: 'notice' }, `${issue.account}: ${issue.kind === 'suspended' ? 'the installation is suspended.' : 'GitHub refused access (an organization may require SAML single sign-on). Sign in to the organization, then reconnect.'}`));
  if (inv.ssoHiddenOrganizations.length) coverage.append(h('p', { className: 'notice' }, 'GitHub hid some organizations that require SAML single sign-on. Authorize your SSO session for them on GitHub, then reconnect here.'));
  if (inv.rejected) coverage.append(h('p', { className: 'muted' }, `${inv.rejected} repositories were skipped because GitHub returned unexpected names.`));
  card.append(coverage);
  return card;
}

function syncCard(d: Diagnostics): HTMLElement {
  const sync = d.layout.sync;
  const used = d.layout.syncBytesInUse ?? (sync.kind === 'ok' ? sync.bytes : 0);
  const pct = Math.min(100, Math.round((used / SYNC_TOTAL_QUOTA) * 100));
  const state =
    sync.kind === 'ok'
      ? h('span', { className: 'ok' }, sync.pending ? 'Saving…' : 'Synced')
      : sync.kind === 'readonly'
        ? h('span', { className: 'bad' }, 'Read-only on this device')
        : h('span', { className: 'bad' }, 'Not syncing');
  const card = h(
    'section',
    { className: 'card', 'aria-labelledby': 'sync-title' },
    h('h2', { id: 'sync-title' }, 'Sections & Chrome Sync'),
    h('p', {}, 'Your sections, their order and which repositories they hold are saved with Chrome Sync, so every Chrome where you are signed in with sync turned on (and the same extension ID) uses them. Only repository IDs are synced.'),
    h(
      'dl',
      { className: 'facts' },
      h('dt', {}, 'State'),
      h('dd', {}, state),
      h('dt', {}, 'Sections'),
      h('dd', {}, String(d.layout.sections)),
      h('dt', {}, 'Placed repositories'),
      h('dd', {}, String(d.layout.assigned)),
      h('dt', {}, 'Chrome Sync storage'),
      h('dd', {}, `${used.toLocaleString()} of ${SYNC_TOTAL_QUOTA.toLocaleString()} bytes`, h('div', { className: 'meter', role: 'presentation' }, h('span', { style: `width:${pct}%` }))),
    ),
  );
  if (sync.kind === 'readonly') card.append(h('p', { className: 'notice' }, sync.reason));
  if (sync.kind === 'error') card.append(h('p', { className: 'notice' }, sync.message));
  const actions = h('div', { className: 'row' });
  if (d.layout.unavailable > 0) {
    card.append(h('p', { className: 'muted' }, `${d.layout.unavailable} placed repositories are not visible on this device (another account, removed, or not installed here). They are kept so other devices keep them.`));
    actions.append(
      button(`Forget ${d.layout.unavailable} unavailable`, () => {
        if (confirm('Remove repositories this device cannot see from your synced sections? Other devices will no longer place them either.')) void act({ type: 'layout/remove-unavailable' }, 'Removed.');
      }),
    );
  }
  actions.append(
    button(
      'Reset sections',
      () => {
        if (confirm('Delete all sections on every synced device? Repositories return to Uncategorized. This cannot be undone.')) void act({ type: 'layout/reset' }, 'Sections reset.');
      },
      'danger',
    ),
  );
  card.append(actions);
  return card;
}

/** Applies a plan in chunks the background accepts; returns what undo needs. */
async function applyPlan(plan: PlanSection[]): Promise<{ created: string[]; moved: RepoId[] }> {
  const { ops, created, moved } = opsForPlan(plan);
  for (const chunk of chunkOps(ops)) await send({ type: 'layout/apply', ops: chunk });
  return { created, moved };
}

async function undoPlan(undo: { created: string[]; moved: RepoId[] }): Promise<void> {
  const ops: LayoutOp[] = [];
  for (let i = 0; i < undo.moved.length; i += 20_000) ops.push({ type: 'unassign', repoIds: undo.moved.slice(i, i + 20_000) });
  for (const id of undo.created) ops.push({ type: 'deleteSection', sectionId: id, expectRepoIds: [] });
  for (const chunk of chunkOps(ops)) await send({ type: 'layout/apply', ops: chunk });
}

/** Suggest sections: fetch hints, preview editable suggestions, apply, undo. */
const organize: {
  phase: 'idle' | 'loading' | 'preview';
  items: (SuggestedSection & { include: boolean })[];
  repoNames: Map<RepoId, string>;
  error: string | null;
  undo: { created: string[]; moved: RepoId[]; summary: string } | null;
} = { phase: 'idle', items: [], repoNames: new Map(), error: null, undo: null };

async function startSuggest(d: Diagnostics): Promise<void> {
  organize.phase = 'loading';
  organize.error = null;
  organize.undo = null;
  render();
  try {
    const state = await send<NavState>({ type: 'nav/get' });
    const placed = new Set(state.layout.layout.sections.flatMap((s) => s.repoIds));
    const repos = state.inventory.repos.filter((r) => !placed.has(r.id));
    // Descriptions help but are optional: without them, suggestions use names, owners and flags only.
    let hints: RepoHint[] = [];
    try {
      hints = await send<RepoHint[]>({ type: 'suggest/hints' });
    } catch (error) {
      organize.error = `Could not read descriptions from GitHub (${error instanceof Error ? error.message : String(error)}), so these suggestions use repository names only.`;
    }
    const login = d.auth.kind === 'signed-in' ? d.auth.login : null;
    organize.items = suggestSections({ repos, hints: new Map(hints.map((h) => [h.id, h])), login }).map((s) => ({ ...s, include: true }));
    organize.repoNames = new Map(state.inventory.repos.map((r) => [r.id, `${r.owner}/${r.name}`]));
    organize.phase = 'preview';
    if (!organize.items.length) {
      organize.phase = 'idle';
      organize.error = repos.length ? 'No confident groupings found. Your repositories stay in Uncategorized; create sections by hand in the GitHub menu.' : 'Every repository is already in a section.';
    }
  } catch (error) {
    organize.phase = 'idle';
    organize.error = error instanceof Error ? error.message : String(error);
  }
  render();
}

async function applySuggestions(): Promise<void> {
  const chosen = organize.items.filter((s) => s.include);
  try {
    const state = await send<NavState>({ type: 'nav/get' });
    const plan = planSections(chosen, state.layout.layout);
    const result = await applyPlan(plan);
    const count = result.moved.length;
    organize.undo = { ...result, summary: `Placed ${plural(count, 'repository', 'repositories')} in ${plural(plan.length, 'section')}.` };
    organize.phase = 'idle';
    organize.items = [];
    message = null;
  } catch (error) {
    organize.error = error instanceof Error ? error.message : String(error);
  }
  await reload();
}

function undoButton(target: { undo: { created: string[]; moved: RepoId[]; summary: string } | null; error: string | null }): HTMLButtonElement {
  return button('Undo', () => {
    const undo = target.undo;
    if (!undo) return;
    void undoPlan(undo)
      .then(() => {
        target.undo = null;
        message = { text: 'Undone. Those repositories are back in Uncategorized.', kind: 'ok' };
      })
      .catch((error: unknown) => {
        target.error = `Undo failed: ${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(() => void reload());
  });
}

/** First few names inline; the rest behind "and N more" so a big section does not become a wall of text. */
function repoPreview(key: string, names: string[]): HTMLElement {
  const SHOWN = 6;
  if (names.length <= SHOWN + 2) return h('p', { className: 'sg-repos muted' }, names.join(', '));
  return h(
    'details',
    { className: 'sg-repos muted', 'data-key': `sg-more-${key}` },
    h('summary', {}, `${names.slice(0, SHOWN).join(', ')} and ${names.length - SHOWN} more`),
    h('p', {}, names.slice(SHOWN).join(', ')),
  );
}

function organizeCard(d: Diagnostics): HTMLElement | null {
  if (d.auth.kind !== 'signed-in' || d.inventory.count === 0) return null;
  const card = h('section', { className: 'card', id: 'organize', 'aria-labelledby': 'organize-title' }, h('h2', { id: 'organize-title' }, 'Organize automatically'));
  if (organize.undo) card.append(h('p', { className: 'ok' }, organize.undo.summary, ' '), h('div', { className: 'row' }, link('See them on GitHub', 'https://github.com/', 'button primary'), undoButton(organize)));
  if (organize.error) card.append(h('p', { className: 'notice', role: 'alert' }, organize.error));
  if (organize.phase === 'loading') {
    card.append(h('p', {}, h('span', { className: 'spinner', 'aria-hidden': 'true' }), ' Reading your repositories and grouping them…'));
    return card;
  }
  if (organize.phase === 'preview') {
    const total = organize.items.filter((s) => s.include).reduce((n, s) => n + s.repoIds.length, 0);
    card.append(
      h('p', {}, 'Here is a suggestion. Untick anything you do not want and rename sections as you like; nothing changes until you click Create.'),
      h(
        'ul',
        { className: 'suggestions' },
        ...organize.items.map((s) => {
          const include = h('input', { type: 'checkbox', checked: s.include, 'aria-label': `Include section ${s.name}`, 'data-key': `sg-inc-${s.key}` });
          include.addEventListener('change', () => {
            s.include = include.checked;
            render();
          });
          const name = h('input', { type: 'text', maxlength: 60, 'aria-label': 'Section name', spellcheck: 'false', 'data-key': `sg-name-${s.key}` });
          name.value = s.name;
          name.addEventListener('input', () => {
            s.name = name.value;
          });
          return h(
            'li',
            { className: s.include ? '' : 'is-off' },
            h('div', { className: 'sg-head' }, include, name, h('span', { className: 'muted' }, `${plural(s.repoIds.length, 'repository', 'repositories')} · ${s.why}${s.collapsed ? ' · starts collapsed' : ''}`)),
            repoPreview(s.key, s.repoIds.map((id) => organize.repoNames.get(id) ?? String(id))),
          );
        }),
      ),
      h(
        'div',
        { className: 'row' },
        button(`Create sections (${plural(total, 'repository', 'repositories')})`, () => void applySuggestions(), 'primary'),
        button('Cancel', () => {
          organize.phase = 'idle';
          organize.items = [];
          render();
        }),
      ),
      h('p', { className: 'muted' }, 'Repositories not listed stay in Uncategorized. A section with an existing section’s name is merged into it.'),
    );
    return card;
  }
  card.append(
    h('p', {}, 'Let the extension suggest sections for repositories that are still in Uncategorized. You see a preview first, and you can undo it afterwards. Repositories you already placed are never moved.'),
    h('div', { className: 'row' }, button('Suggest sections', () => void startSuggest(d), 'primary')),
    h(
      'p',
      { className: 'muted' },
      'It groups by name patterns, owner and archived/fork status, plus each repository’s description, language and topics, which it reads from GitHub just for this. Those details are used once for the preview and are not stored or synced.',
    ),
  );
  return card;
}

/** Export / import sections as a file. */
const transfer: { plan: PlanSection[] | null; fileName: string; error: string | null; undo: { created: string[]; moved: RepoId[]; summary: string } | null } = {
  plan: null,
  fileName: '',
  error: null,
  undo: null,
};

async function exportFile(): Promise<void> {
  try {
    const state = await send<NavState>({ type: 'nav/get' });
    const file = exportSections(state.layout.layout, state.inventory.repos, new Date());
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' })), download: `repo-navigator-sections-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    message = { text: `Exported ${plural(file.sections.length, 'section')}.`, kind: 'ok' };
  } catch (error) {
    transfer.error = error instanceof Error ? error.message : String(error);
  }
  render();
}

async function readImport(file: File): Promise<void> {
  transfer.error = null;
  transfer.plan = null;
  transfer.undo = null;
  if (file.size > 5_000_000) {
    transfer.error = 'That file is too large to be a sections file.';
    render();
    return;
  }
  const parsed = parseSectionsFile(await file.text());
  if (!parsed.ok) {
    transfer.error = parsed.error;
    render();
    return;
  }
  try {
    const state = await send<NavState>({ type: 'nav/get' });
    transfer.plan = planImport(parsed.file, state.layout.layout, state.inventory.repos);
    transfer.fileName = file.name;
  } catch (error) {
    transfer.error = error instanceof Error ? error.message : String(error);
  }
  render();
}

async function applyImport(): Promise<void> {
  const plan = transfer.plan;
  if (!plan) return;
  try {
    const result = await applyPlan(plan);
    transfer.undo = { ...result, summary: `Imported ${plural(plan.filter((s) => s.repoIds.length).length, 'section')} with ${plural(result.moved.length, 'repository', 'repositories')}.` };
    transfer.plan = null;
  } catch (error) {
    transfer.error = error instanceof Error ? error.message : String(error);
  }
  await reload();
}

function transferCard(d: Diagnostics): HTMLElement | null {
  if (d.auth.kind !== 'signed-in' || d.inventory.count === 0) return null;
  const card = h('section', { className: 'card', 'aria-labelledby': 'transfer-title' }, h('h2', { id: 'transfer-title' }, 'Back up or share sections'));
  if (transfer.undo) card.append(h('p', { className: 'ok' }, transfer.undo.summary), h('div', { className: 'row' }, undoButton(transfer)));
  if (transfer.error) card.append(h('p', { className: 'notice', role: 'alert' }, transfer.error));
  if (transfer.plan) {
    const plan = transfer.plan;
    const moving = plan.reduce((n, s) => n + s.repoIds.length, 0);
    const missing = plan.reduce((n, s) => n + s.missing, 0);
    card.append(
      h('p', {}, `“${transfer.fileName}” would place ${plural(moving, 'repository', 'repositories')}:`),
      h(
        'ul',
        { className: 'plain' },
        ...plan.map((s) => h('li', {}, h('strong', {}, s.name), ` · ${plural(s.repoIds.length, 'repository', 'repositories')}${s.existingId ? ' (added to your existing section)' : ' (new section)'}${s.missing ? `, ${s.missing} not visible here` : ''}`)),
      ),
      ...(missing ? [h('p', { className: 'muted' }, `${plural(missing, 'listed repository is', 'listed repositories are')} not visible with this account and will be skipped.`)] : []),
      h('p', { className: 'muted' }, 'Repositories already in a section are moved to the imported one. You can undo this afterwards.'),
      h(
        'div',
        { className: 'row' },
        button('Import', () => void applyImport(), 'primary'),
        button('Cancel', () => {
          transfer.plan = null;
          render();
        }),
      ),
    );
    return card;
  }
  const input = h('input', { type: 'file', accept: '.json,application/json', className: 'sr-only', id: 'import-file', 'aria-label': 'Sections file to import' });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void readImport(file);
  });
  card.append(
    h('p', {}, 'Save your sections to a file, or load sections from a file: a backup, another browser profile, or a list someone made for you. You see what it will do before anything changes.'),
    h('div', { className: 'row' }, button('Export sections', () => void exportFile()), button('Import sections…', () => input.click()), input),
  );
  return card;
}

/** Plain statement of exactly which parts of github.com the extension touches, so nobody has to guess. */
function effectsCard(): HTMLElement {
  return h(
    'section',
    { className: 'card', 'aria-labelledby': 'effects-title' },
    h('h2', { id: 'effects-title' }, 'What this changes on GitHub'),
    h('p', {}, 'GitHub shows a short “Top repositories” list in two places. The extension replaces both with your complete, organized list:'),
    h(
      'ul',
      { className: 'effects' },
      h(
        'li',
        {},
        h('strong', {}, 'The ☰ menu'),
        h('span', { className: 'muted' }, 'Click the ☰ button at the top-left of any github.com page, next to the GitHub logo. In the side menu that slides out, the Top repositories section becomes your full list.'),
      ),
      h(
        'li',
        {},
        h('strong', {}, 'The dashboard sidebar'),
        h('span', { className: 'muted' }, 'On github.com’s home page (the dashboard), the Top repositories list on the left becomes your full list too.'),
      ),
    ),
    h('p', {}, 'In both places you get the same thing: every repository you can access, a filter box, and your own sections. Sections, their order and which repositories they hold are shared between both places and synced to your other Chrome devices.'),
    h(
      'p',
      { className: 'muted' },
      'Nothing else on GitHub changes: not the rest of the menu, not repository pages, not search. If GitHub changes its page layout in a way the extension does not recognise, GitHub’s own list stays in place instead of breaking.',
    ),
  );
}

function privacyCard(d: Diagnostics): HTMLElement {
  return h(
    'section',
    { className: 'card', 'aria-labelledby': 'privacy-title' },
    h('h2', { id: 'privacy-title' }, 'Privacy'),
    h(
      'ul',
      { className: 'plain' },
      h('li', {}, 'The extension talks only to github.com (sign-in) and api.github.com (repository list). There is no other server.'),
      h('li', {}, 'GitHub access is read-only repository metadata. The extension cannot change anything on GitHub.'),
      h(
        'li',
        {},
        'Tokens and the repository list stay in this browser’s local extension storage: each browser connects to GitHub on its own. Chrome Sync carries section names, order and repository IDs, plus the client IDs of your GitHub Apps (public identifiers, not secrets), which accounts sign in through an app of their own (by GitHub user ID), and whether you already chose how to start.',
      ),
      h('li', {}, 'With more than one GitHub account connected, each keeps its own sections and repository list. On github.com the extension reads only which account the page is signed in as, to show that account’s list.'),
      h('li', {}, 'Stored per repository: ID, owner, name, owner avatar URL, visibility, archived/fork flags and last push time. No code, issues, descriptions or topics.'),
      h('li', {}, 'Only when you click Suggest sections, descriptions, languages and topics are read from GitHub to build the suggestion. They are used once and not stored or synced.'),
    ),
    h(
      'details',
      { 'data-key': 'advanced' },
      h('summary', {}, 'Advanced'),
      h('p', { className: 'muted' }, `Client ID in use: ${d.clientId.value || '(none)'} (${d.clientId.source === 'options' ? 'saved here, synced to your other browsers' : d.clientId.source}). Version ${d.extensionVersion}${CONFIG.e2e ? ' (test build)' : ''}.`),
      ...d.ownApps.map((o) => {
        const who = o.login ? `@${o.login}` : 'An account connected on another browser';
        return h('p', { className: 'muted copy-line' }, `${who} signs in through its own GitHub App: `, h('code', {}, o.clientId), copyButton(() => o.clientId, `client ID of ${o.login ? `@${o.login}’s` : 'that'} app`));
      }),
      d.clientId.value
        ? h(
            'div',
            { className: 'row' },
            button('Copy client ID', () => {
              void navigator.clipboard.writeText(d.clientId.value).then(
                () => {
                  message = { text: 'Client ID copied. In the other browser, choose “I already use Repo Navigator in another browser” and paste it.', kind: 'ok' };
                  render();
                },
                () => undefined,
              );
            }),
          )
        : null,
      clientIdGuide('guide-advanced', 'How to get a GitHub App client ID'),
      clientIdForm(d, 'client-id-advanced'),
      h(
        'div',
        { className: 'row' },
        button('Clear cached repositories', () => void act({ type: 'data/clear-cache' }, 'Cache cleared; refreshing.')),
        isHidden(d)
          ? button('Show the setup guide again', () => {
              wizard.hidden = wizard.hidden.filter((id) => id !== d.account);
              saveWizard();
              selectTab('setup');
            })
          : null,
      ),
    ),
  );
}

/** First run, repositories loaded, nothing organized: ask once, above every tab, how to start. */
function startChoiceCard(d: Diagnostics): HTMLElement | null {
  if (!d.startChoice || organize.phase !== 'idle' || organize.undo) return null;
  return h(
    'section',
    { className: 'card start', 'aria-labelledby': 'start-title' },
    h('h2', { id: 'start-title' }, 'How do you want to start?'),
    h(
      'p',
      {},
      `Your ${plural(d.inventory.count, 'repository', 'repositories')} are loaded. Repo Navigator can sort them into sections for you: you see a preview first, can rename or untick anything, and can undo it. Or start with one list and make sections yourself.`,
    ),
    h(
      'div',
      { className: 'row' },
      button(
        'Suggest sections for me',
        () => {
          selectTab('organize');
          void startSuggest(d);
        },
        'primary',
      ),
      button('Start with one list', () => void act({ type: 'onboarding/start-empty' }, 'Starting with one list. Make sections any time with + in the GitHub menu, or with Suggest sections on the Organize tab.')),
    ),
  );
}

/** Organize needs repositories; until then the tab says what is missing instead of being empty. */
function organizePlaceholder(): HTMLElement {
  return h(
    'section',
    { className: 'card', 'aria-labelledby': 'organize-wait-title' },
    h('h2', { id: 'organize-wait-title' }, 'Organize'),
    h('p', {}, 'Suggesting sections and backing them up become available once GitHub is connected and your repositories have loaded.'),
    h('div', { className: 'row' }, button('Go to Setup', () => selectTab('setup', true), 'primary')),
  );
}

function tabBar(d: Diagnostics, tab: OptionsTab): HTMLElement {
  const attention: Partial<Record<OptionsTab, string>> = {};
  if (setupProgress(d).step !== 'done') attention.setup = 'setup not finished';
  if (d.startChoice) attention.organize = 'not organized yet';
  const buttons = TABS.map((t) => {
    const b = h(
      'button',
      { type: 'button', role: 'tab', id: `tab-${t.id}`, 'aria-selected': String(t.id === tab), 'aria-controls': 'panel', tabIndex: t.id === tab ? 0 : -1, 'data-key': `tab-${t.id}` },
      t.label,
      attention[t.id] ? h('span', { className: 'dot', title: attention[t.id] }, h('span', { className: 'sr-only' }, ` (${attention[t.id]})`)) : null,
    );
    b.addEventListener('click', () => selectTab(t.id));
    return b;
  });
  const bar = h('div', { className: 'tabs', role: 'tablist', 'aria-label': 'Settings' }, ...buttons);
  // Arrow keys move between tabs (WAI-ARIA tabs pattern, automatic activation).
  bar.addEventListener('keydown', (event) => {
    const index = TABS.findIndex((t) => t.id === tab);
    const next = ({ ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 } as Record<string, number>)[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(TABS[(next + TABS.length) % TABS.length]!.id, true);
  });
  return bar;
}

function render(): void {
  // Keep focus, caret and each <details>' open/closed state across re-renders.
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active?.getAttribute('data-key') ?? null;
  const selection: [number | null, number | null] | null = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
  const detailsOpen = new Map<string, boolean>();
  for (const el of document.querySelectorAll<HTMLDetailsElement>('details[data-key]')) detailsOpen.set(el.dataset.key!, el.open);
  paint();
  for (const el of document.querySelectorAll<HTMLDetailsElement>('details[data-key]')) {
    const open = detailsOpen.get(el.dataset.key!);
    if (open !== undefined) el.open = open;
  }
  if (focusKey) {
    const target = document.querySelector<HTMLElement>(`[data-key="${focusKey}"]`);
    target?.focus();
    if (target instanceof HTMLInputElement && selection) target.setSelectionRange(selection[0], selection[1]);
  }
}

function paint(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
  const d = diagnostics;
  const header = h(
    'header',
    { className: 'page' },
    h('img', { src: 'icons/icon48.png', alt: '' }),
    h('div', {}, h('h1', {}, 'GitHub Repo Navigator'), h('div', { className: 'version' }, d ? `Version ${d.extensionVersion}` : '')),
  );
  const status = message ? h('p', { className: message.kind === 'ok' ? 'ok' : 'notice', role: message.kind === 'bad' ? 'alert' : 'status' }, message.text) : null;
  if (!d) {
    app.replaceChildren(header, status ?? h('p', { className: 'muted' }, 'Loading…'));
    return;
  }
  const access = siteAccess
    ? null
    : h(
        'p',
        { className: 'notice', role: 'alert' },
        'Site access is restricted for this extension, so it cannot sign in or show the navigator on github.com. On chrome://extensions → GitHub Repo Navigator → Details → Site access, allow github.com and api.github.com.',
      );
  // While setup is on its create/connect stages, the guide is the connection UI; afterwards the normal card shows.
  activeTab ??= defaultTab(d);
  const tab = activeTab;
  const cards = (list: (HTMLElement | null)[]) => list.filter((x): x is HTMLElement => !!x);
  let content: HTMLElement[];
  switch (tab) {
    case 'setup': {
      if (wizard.add) {
        // Adding an account: its guide connects it; the card below lists the accounts already here.
        content = cards([addCard(d), d.accounts.length ? authCard(d) : null, effectsCard()]);
        break;
      }
      // While setup is on its create/connect stages, the guide is the connection UI; afterwards the normal card shows.
      const setup = setupCard(d);
      const step = setupProgress(d).step;
      content = cards([setup, !setup || step === 'install' || step === 'done' ? authCard(d) : null, effectsCard()]);
      break;
    }
    case 'organize': {
      const organizing = cards([organizeCard(d), transferCard(d)]);
      content = organizing.length ? organizing : [organizePlaceholder()];
      break;
    }
    case 'repositories':
      content = [inventoryCard(d), syncCard(d)];
      break;
    case 'privacy':
      content = [privacyCard(d)];
      break;
  }
  const picker = accountPicker(d);
  if (picker) header.append(picker);
  app.replaceChildren(
    header,
    ...cards([status, access, startChoiceCard(d)]),
    tabBar(d, tab),
    h('div', { className: 'tab-panel', role: 'tabpanel', id: 'panel', 'aria-labelledby': `tab-${tab}` }, ...content),
  );
  if (!app.classList.contains('settled')) setTimeout(() => app.classList.add('settled'), 600);
  if (d.connect.kind === 'authorizing') {
    const expiresAt = d.connect.expiresAt;
    ticker = setInterval(() => {
      const el = document.getElementById('countdown');
      if (el) el.textContent = `Code expires in ${countdown(expiresAt)}.`;
    }, 1000);
  }
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (!isBroadcast(msg)) return;
  // Bursts of background updates (refresh, sync) become one reload.
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void reload();
  }, 150);
});

// Another Options tab changed the guide (for example, it started adding an account): follow it, so this tab never
// writes back its older copy.
window.addEventListener('storage', (event) => {
  if (event.key !== WIZARD_KEY) return;
  Object.assign(wizard, loadWizard());
  render();
});
window.addEventListener('focus', autoCheck);
document.addEventListener('visibilitychange', autoCheck);

void reload();
