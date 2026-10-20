import { applyOps, type LayoutOp } from '../shared/layout/model';
import type { Broadcast, NavState, Request, Response } from '../shared/messages';
import type { LayoutSnapshot } from '../shared/types';

export interface Transport {
  send(request: Request): Promise<Response>;
  /** Registers a listener for service-worker broadcasts; returns an unsubscribe function. */
  subscribe(listener: (message: Broadcast) => void): () => void;
}

function newer(a: LayoutSnapshot['version'], b: LayoutSnapshot['version']): boolean {
  return a.epoch !== b.epoch || a.seq > b.seq;
}

/**
 * Content-side mirror of the service worker's state. Layout edits are shown immediately (optimistic) and
 * replayed on top of whatever the worker reports until it acknowledges them; operations are idempotent, so a
 * broadcast that already contains them does no harm.
 */
export class ContentStore {
  private state: NavState | null = null;
  private unacked: { id: number; ops: LayoutOp[] }[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  lastError: string | null = null;

  constructor(private readonly transport: Transport) {}

  async load(): Promise<NavState> {
    this.unsubscribe ??= this.transport.subscribe((message) => this.onBroadcast(message));
    const response = await this.transport.send({ type: 'nav/get' });
    if (!response.ok) throw new Error(response.error);
    this.state = response.data as NavState;
    this.notify();
    return this.state;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Current state with unacknowledged local edits applied. */
  view(): NavState | null {
    if (!this.state) return null;
    if (!this.unacked.length) return this.state;
    const inventory = new Set(this.state.inventory.repos.map((r) => r.id));
    const layout = applyOps(
      this.state.layout.layout,
      this.unacked.flatMap((u) => u.ops),
      { inventory },
    );
    return { ...this.state, layout: { ...this.state.layout, layout } };
  }

  private onBroadcast(message: Broadcast): void {
    if (!this.state) return;
    if (message.type === 'nav/accounts') {
      // The page's account may have been connected or disconnected just now: ask again which state is ours.
      void this.load().catch(() => undefined);
      return;
    }
    // Another account's change (connected here too, but not the one this page is signed in as).
    if (message.account !== (this.state.account?.userId ?? null)) return;
    switch (message.type) {
      case 'nav/layout':
        if (!newer(message.layout.version, this.state.layout.version)) return;
        this.state = { ...this.state, layout: message.layout };
        break;
      case 'nav/inventory':
        this.state = { ...this.state, inventory: message.inventory };
        break;
      case 'nav/auth':
        this.state = { ...this.state, auth: message.auth };
        break;
      case 'nav/onboarding':
        this.state = { ...this.state, onboarding: message.onboarding };
        break;
    }
    this.notify();
  }

  /** Applies edits optimistically; resolves to an error message when the worker rejected them. */
  async apply(ops: LayoutOp[]): Promise<string | null> {
    const entry = { id: this.nextId++, ops };
    this.unacked.push(entry);
    this.lastError = null;
    this.notify();
    let response: Response;
    try {
      response = await this.transport.send({ type: 'layout/apply', ops });
    } catch {
      response = { ok: false, error: 'The extension was updated or restarted. Reload the page to keep editing.' };
    }
    this.unacked = this.unacked.filter((u) => u.id !== entry.id);
    if (response.ok) {
      const snapshot = response.data as LayoutSnapshot;
      if (this.state && newer(snapshot.version, this.state.layout.version)) this.state = { ...this.state, layout: snapshot };
    } else {
      this.lastError = response.error;
    }
    this.notify();
    return response.ok ? null : response.error;
  }

  async send(request: Request): Promise<Response> {
    try {
      return await this.transport.send(request);
    } catch {
      return { ok: false, error: 'The extension was updated or restarted. Reload the page.' };
    }
  }
}
