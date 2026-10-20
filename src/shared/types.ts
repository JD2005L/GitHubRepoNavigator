/** Immutable numeric GitHub repository ID (`repository.id`). Survives renames and transfers. */
export type RepoId = number;

/** Device-local navigation metadata for one repository. Nothing beyond what the navigator renders. */
export interface RepoRecord {
  id: RepoId;
  nodeId: string;
  owner: string;
  name: string;
  /** Only ever an https://avatars.githubusercontent.com/ URL, or null. */
  ownerAvatarUrl: string | null;
  private: boolean;
  visibility: 'public' | 'private' | 'internal';
  archived: boolean;
  fork: boolean;
  pushedAt: string | null;
}

export interface Section {
  id: string;
  name: string;
  collapsed: boolean;
  /** Ordered explicit assignments. May contain IDs this device cannot see; they are kept, never rendered. */
  repoIds: RepoId[];
  /** Trailing per-section fields written by a newer schema, preserved verbatim. */
  extra?: unknown[];
}

export interface Layout {
  sections: Section[];
  /** Top-level payload fields written by a newer schema, preserved verbatim. */
  extra: Record<string, unknown>;
}

export interface AuthProblem {
  message: string;
  /** True when simply starting again can fix it; false for configuration problems. */
  restartable: boolean;
}

export type AuthState =
  | { kind: 'signed-out'; clientIdConfigured: boolean; problem: AuthProblem | null }
  | { kind: 'authorizing'; userCode: string; verificationUri: string; expiresAt: number }
  | { kind: 'signed-in'; login: string | null; expiresAt: number | null }
  | { kind: 'expired'; login: string | null };

export type InventoryStatus =
  | { kind: 'idle' }
  | { kind: 'refreshing' }
  | { kind: 'rate-limited'; resetAt: number }
  | { kind: 'offline' }
  | { kind: 'error'; message: string };

export interface InstallationSummary {
  id: number;
  account: string;
  accountType: string;
  /** 'all' or 'selected' (kept as a string so new GitHub values do not break parsing). */
  repositorySelection: string;
  /** https://github.com/... page where the user can change which repositories the app can see. */
  settingsUrl: string | null;
  suspended: boolean;
}

/** Used only to suggest sections; fetched on request, never stored or synced. */
export interface RepoHint {
  id: RepoId;
  description: string;
  language: string;
  topics: string[];
}

export interface InventorySnapshot {
  repos: RepoRecord[];
  fetchedAt: number | null;
  installations: InstallationSummary[];
  status: InventoryStatus;
}

export type SyncHealth =
  | { kind: 'ok'; bytes: number; chunks: number; lastWriteAt: number | null; pending: boolean }
  | { kind: 'readonly'; reason: string; writtenBySchema: number }
  | { kind: 'error'; message: string; pending: boolean };

export interface LayoutSnapshot {
  layout: Layout;
  /** Monotonic within a service-worker lifetime; `epoch` changes when the worker restarts. */
  version: { epoch: string; seq: number };
  sync: SyncHealth;
  editable: boolean;
}
