import { UNCATEGORIZED_ID, type LayoutOp } from './layout/model';
import type { AuthState, InstallationSummary, InventorySnapshot, LayoutSnapshot } from './types';

/** Everything a navigator view needs. Never contains a token. */
export interface NavState {
  /**
   * The GitHub account this state is for (the one the page is signed in as, when it is connected here), or null:
   * the page's account is not connected, and `auth` is the state of connecting one.
   */
  account: { userId: number; login: string | null } | null;
  /** Logins of every account connected on this device (including expired ones). */
  accounts: string[];
  /** The account the asking page is signed in as, as it asked (null: it did not say). */
  pageLogin: string | null;
  auth: AuthState;
  inventory: InventorySnapshot;
  layout: LayoutSnapshot;
  onboarding: Onboarding;
}

/** First-run state of one account's layout, synced with it. */
export interface Onboarding {
  /** The user answered "how do you want to start?" (or already has sections), so it is never asked again. */
  startChosen: boolean;
}

/** The Options page tabs; the navigator can open one directly. */
export const OPTIONS_TABS = ['setup', 'organize', 'repositories', 'privacy'] as const;
export type OptionsTab = (typeof OPTIONS_TABS)[number];

/**
 * Whether to ask "suggest sections or start with one list?": once, after the first inventory arrives, while
 * nothing is organized yet. Shown on the Options page and in the navigator on GitHub, whichever comes first.
 */
export function needsStartChoice(state: Pick<NavState, 'auth' | 'inventory' | 'layout' | 'onboarding'>): boolean {
  return (
    !state.onboarding.startChosen &&
    state.auth.kind === 'signed-in' &&
    state.inventory.repos.length > 0 &&
    state.layout.editable &&
    !state.layout.layout.sections.some((s) => s.id !== UNCATEGORIZED_ID)
  );
}

export interface AccountSummary {
  userId: number;
  login: string | null;
  kind: 'signed-in' | 'expired';
}

export interface Diagnostics {
  extensionVersion: string;
  clientId: { value: string; source: 'build' | 'options' | 'none' };
  appSlug: string;
  /** Accounts connected on this device, in the order they were connected. */
  accounts: AccountSummary[];
  /** The account everything below describes (null: none is connected). */
  account: number | null;
  /** That account's state, or (none) the state of connecting one. */
  auth: AuthState;
  /** Connecting an account: in progress (`authorizing`), or not (`signed-out`, with any problem from the last try). */
  connect: AuthState;
  inventory: {
    count: number;
    fetchedAt: number | null;
    pages: number;
    notModifiedPages: number;
    rejected: number;
    installations: InstallationSummary[];
    installationIssues: { account: string; kind: string }[];
    ssoHiddenOrganizations: string[];
    rateLimit: { limit: number | null; remaining: number | null; resetAt: number | null };
    status: InventorySnapshot['status'];
  };
  layout: {
    sections: number;
    assigned: number;
    unavailable: number;
    sync: LayoutSnapshot['sync'];
    editable: boolean;
    syncBytesInUse: number | null;
  };
  /** needsStartChoice() for the current state. */
  startChoice: boolean;
}

/** Requests any extension context may send. */
export type PublicRequest =
  | { type: 'nav/get' }
  | { type: 'layout/apply'; ops: LayoutOp[] }
  | { type: 'inventory/refresh'; force?: boolean }
  /** tab: open the Options page on that tab; suggest: and start suggesting sections there. */
  | { type: 'options/open'; tab?: OptionsTab; suggest?: boolean }
  /** "Start with one list": the first-run question is answered. */
  | { type: 'onboarding/start-empty' };

/** Requests only extension pages (the options page) may send. */
export type PrivilegedRequest =
  | { type: 'auth/start' }
  | { type: 'auth/cancel' }
  | { type: 'auth/signout' }
  | { type: 'config/set-client-id'; clientId: string }
  | { type: 'diagnostics/get' }
  | { type: 'layout/reset' }
  | { type: 'layout/remove-unavailable' }
  | { type: 'data/clear-cache' }
  /** Descriptions, languages and topics for suggesting sections. Fetched live; never stored. */
  | { type: 'suggest/hints' };

/**
 * `account`: the login of the GitHub account the request is about. Pages on github.com send the account they are
 * signed in as; Options sends the one it shows. Without it, the first connected account is meant.
 */
export type Request = (PublicRequest | PrivilegedRequest) & { account?: string };

export const PRIVILEGED_TYPES: ReadonlySet<string> = new Set<PrivilegedRequest['type']>([
  'auth/start',
  'auth/cancel',
  'auth/signout',
  'config/set-client-id',
  'diagnostics/get',
  'layout/reset',
  'layout/remove-unavailable',
  'data/clear-cache',
  'suggest/hints',
]);

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Pushed from the service worker to github.com tabs and extension pages. `account` is the user ID the change
 * belongs to (null: connecting an account); a view applies only its own account's changes. `nav/accounts`: an
 * account was connected or disconnected, so a view may now belong to a different one and should load again.
 */
export type Broadcast =
  | { type: 'nav/layout'; account: number; layout: LayoutSnapshot }
  | { type: 'nav/inventory'; account: number; inventory: InventorySnapshot }
  | { type: 'nav/auth'; account: number | null; auth: AuthState }
  | { type: 'nav/onboarding'; account: number; onboarding: Onboarding }
  | { type: 'nav/accounts' };

export function isBroadcast(value: unknown): value is Broadcast {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'nav/layout' || type === 'nav/inventory' || type === 'nav/auth' || type === 'nav/onboarding' || type === 'nav/accounts';
}
