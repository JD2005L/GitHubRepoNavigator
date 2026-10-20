import { isBroadcast, type Broadcast, type Request, type Response } from '../shared/messages';
import { DrawerMounter } from './mount';
import { ContentStore, type Transport } from './store';

/**
 * Content script for github.com. It never reads tokens or chrome.storage: everything comes from the service
 * worker by message. It only touches GitHub's page in two places: the Top repositories list of the global
 * navigation drawer and the one in the dashboard's left sidebar.
 */
/**
 * The GitHub account this page is signed in as. GitHub names it in a meta tag on every signed-in page, and it
 * changes with GitHub's account switcher, so it is read for every request rather than once.
 */
function pageLogin(): string | undefined {
  const login = document.querySelector<HTMLMetaElement>('meta[name="user-login"]')?.content.trim();
  return login || undefined;
}

const transport: Transport = {
  send: async (request: Request) => {
    try {
      return await chrome.runtime.sendMessage<Request, Response>({ ...request, account: pageLogin() });
    } catch (error) {
      // "Extension context invalidated": the extension was reloaded, updated or removed under this tab.
      if (!alive()) mounter.stop();
      throw error;
    }
  },
  subscribe: (listener: (message: Broadcast) => void) => {
    const handler = (message: unknown) => {
      if (isBroadcast(message)) listener(message);
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  },
};

const store = new ContentStore(transport);
let loading: Promise<unknown> | null = null;
let lastLoad = 0;

function refreshState(): void {
  // Coalesce: a drawer opening and a header hover in quick succession need one round trip.
  if (!alive() || loading || Date.now() - lastLoad < 1500) return;
  lastLoad = Date.now();
  loading = store
    .load()
    .catch(() => undefined)
    .finally(() => {
      loading = null;
    });
}

/** After the extension is reloaded or updated, this (orphaned) script can no longer reach the extension. */
function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

const mounter = new DrawerMounter(document, store, {
  isAlive: alive,
  onDrawerOpen: refreshState,
  log: (message, error) => console.warn(`[GitHub Repo Navigator] ${message}`, error instanceof Error ? error.message : ''),
});

if (!document.body?.classList.contains('logged-out')) {
  mounter.start();
  // Warm the state when the user heads for the menu button, so the drawer opens with the full list.
  document.addEventListener(
    'pointerover',
    (event) => {
      const target = event.target as Element | null;
      if (target?.closest?.('header button, [aria-haspopup="dialog"], [aria-label="Open global navigation menu"]')) refreshState();
    },
    { capture: true, passive: true },
  );
}
