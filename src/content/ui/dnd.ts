/** Geometry of one drop zone, in client coordinates. */
export interface RepoDropItem {
  kind: 'header' | 'repo' | 'empty';
  sectionId: string;
  repoId?: number;
  top: number;
  bottom: number;
  collapsed: boolean;
  /** Uncategorized: sorted automatically, so it only accepts "into the section". */
  automatic: boolean;
}

export type Indicator = { kind: 'line'; y: number } | { kind: 'section'; sectionId: string };

export interface RepoDropTarget {
  sectionId: string;
  beforeRepoId: number | null;
  indicator: Indicator;
}

function pick<T extends { top: number; bottom: number }>(items: T[], y: number): T | null {
  if (!items.length) return null;
  for (const item of items) if (y >= item.top && y < item.bottom) return item;
  if (y < items[0]!.top) return items[0]!;
  // Between zones (gaps, margins): the nearest zone above.
  let best: T | null = null;
  for (const item of items) if (item.top <= y) best = item;
  return best ?? items[items.length - 1]!;
}

function firstRepoAfter(items: RepoDropItem[], index: number, sectionId: string): number | null {
  for (let i = index + 1; i < items.length; i++) {
    const item = items[i]!;
    if (item.sectionId !== sectionId) return null;
    if (item.kind === 'repo') return item.repoId ?? null;
  }
  return null;
}

/** Where a dragged repository would land for a pointer at client Y. Pure, so it is unit-tested. */
export function computeRepoDrop(y: number, items: RepoDropItem[]): RepoDropTarget | null {
  const item = pick(items, y);
  if (!item) return null;
  const index = items.indexOf(item);
  if (item.automatic || item.kind === 'empty' || (item.kind === 'header' && item.collapsed)) {
    return { sectionId: item.sectionId, beforeRepoId: null, indicator: { kind: 'section', sectionId: item.sectionId } };
  }
  if (item.kind === 'header') {
    return { sectionId: item.sectionId, beforeRepoId: firstRepoAfter(items, index, item.sectionId), indicator: { kind: 'line', y: item.bottom } };
  }
  const mid = (item.top + item.bottom) / 2;
  if (y < mid) return { sectionId: item.sectionId, beforeRepoId: item.repoId ?? null, indicator: { kind: 'line', y: item.top } };
  return { sectionId: item.sectionId, beforeRepoId: firstRepoAfter(items, index, item.sectionId), indicator: { kind: 'line', y: item.bottom } };
}

export interface SectionBox {
  sectionId: string;
  top: number;
  bottom: number;
}

/** Sections are dropped between each other: before the first section whose middle is below the pointer. */
export function computeSectionDrop(y: number, boxes: SectionBox[]): { beforeSectionId: string | null; y: number } | null {
  if (!boxes.length) return null;
  for (const box of boxes) {
    if (y < (box.top + box.bottom) / 2) return { beforeSectionId: box.sectionId, y: box.top };
  }
  return { beforeSectionId: null, y: boxes[boxes.length - 1]!.bottom };
}

export interface DragHost {
  /** Element that positions the ghost and indicator (position: relative, inside the shadow root). */
  layer: HTMLElement;
  repoTargets(): RepoDropItem[];
  sectionTargets(): SectionBox[];
  dropRepo(repoId: number, target: RepoDropTarget): void;
  dropSection(sectionId: string, beforeSectionId: string | null): void;
  scrollContainer(): HTMLElement | null;
  label(kind: 'repo' | 'section', id: string): string;
  setDragging(kind: 'repo' | 'section', id: string, active: boolean): void;
  highlightSection(sectionId: string | null): void;
}

const THRESHOLD = 5;
const EDGE = 40;

type Pending = { kind: 'repo' | 'section'; id: string; x: number; y: number; pointerId: number; source: HTMLElement };

/**
 * Pointer-based drag and drop. Native HTML5 DnD is unreliable inside shadow roots and offers no keyboard path;
 * this controller is small, works with mouse, pen and touch (touch only from the grip so scrolling still works)
 * and leaves the keyboard alternatives to the view.
 */
export class DragController {
  private pending: Pending | null = null;
  private active = false;
  private ghost: HTMLElement | null = null;
  private line: HTMLElement | null = null;
  private lastY = 0;
  private lastX = 0;
  private scrollFrame = 0;
  private target: RepoDropTarget | { beforeSectionId: string | null } | null = null;

  constructor(private readonly root: HTMLElement, private readonly host: DragHost) {
    root.addEventListener('pointerdown', this.onPointerDown);
    root.addEventListener('dragstart', (e) => e.preventDefault()); // links/images must not start native drags
  }

  get dragging(): boolean {
    return this.active;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.pending || this.active) return;
    const target = event.target as Element | null;
    if (!target) return;
    const onGrip = !!target.closest('[data-grip]');
    if (target.closest('button, input, [role="menu"]') && !onGrip) return;
    if (event.pointerType === 'touch' && !onGrip) return;
    const source = target.closest<HTMLElement>('[data-drag-repo], [data-drag-section]');
    if (!source || source.closest('[data-readonly]')) return;
    const kind = source.hasAttribute('data-drag-repo') ? 'repo' : 'section';
    const id = source.getAttribute(kind === 'repo' ? 'data-drag-repo' : 'data-drag-section') ?? '';
    // Sections drag only by their grip; repositories by the whole row.
    if (kind === 'section' && !onGrip) return;
    this.pending = { kind, id, x: event.clientX, y: event.clientY, pointerId: event.pointerId, source };
    if (onGrip) event.preventDefault();
    window.addEventListener('pointermove', this.onPointerMove, true);
    window.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('pointercancel', this.onCancel, true);
    window.addEventListener('keydown', this.onKeyDown, true);
  };

  private onPointerMove = (event: PointerEvent): void => {
    const pending = this.pending;
    if (!pending || event.pointerId !== pending.pointerId) return;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (!this.active) {
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < THRESHOLD) return;
      this.start(pending);
    }
    event.preventDefault();
    this.update();
  };

  private start(pending: Pending): void {
    this.active = true;
    try {
      pending.source.setPointerCapture(pending.pointerId);
    } catch {
      // Capture is best effort; window listeners still track the pointer.
    }
    this.ghost = document.createElement('div');
    this.ghost.className = 'grn-ghost';
    this.ghost.textContent = this.host.label(pending.kind, pending.id);
    this.line = document.createElement('div');
    this.line.className = 'grn-drop-line';
    this.line.hidden = true;
    this.host.layer.append(this.ghost, this.line);
    this.host.setDragging(pending.kind, pending.id, true);
  }

  private update(): void {
    const pending = this.pending;
    if (!pending || !this.ghost || !this.line) return;
    const layerRect = this.host.layer.getBoundingClientRect();
    this.ghost.style.transform = `translate(${Math.round(this.lastX - layerRect.left + 12)}px, ${Math.round(this.lastY - layerRect.top - 10)}px)`;
    if (pending.kind === 'repo') {
      const target = computeRepoDrop(this.lastY, this.host.repoTargets());
      this.target = target;
      if (target?.indicator.kind === 'line') {
        this.line.hidden = false;
        this.line.style.transform = `translateY(${Math.round(target.indicator.y - layerRect.top - 1)}px)`;
        this.host.highlightSection(null);
      } else {
        this.line.hidden = true;
        this.host.highlightSection(target?.indicator.kind === 'section' ? target.indicator.sectionId : null);
      }
    } else {
      const target = computeSectionDrop(this.lastY, this.host.sectionTargets());
      this.target = target;
      this.line.hidden = !target;
      if (target) this.line.style.transform = `translateY(${Math.round(target.y - layerRect.top - 1)}px)`;
    }
    this.autoScroll();
  }

  private autoScroll(): void {
    const container = this.host.scrollContainer();
    if (!container || this.scrollFrame) return;
    const rect = container.getBoundingClientRect();
    let delta = 0;
    if (this.lastY < rect.top + EDGE) delta = -Math.ceil((rect.top + EDGE - this.lastY) / 4);
    else if (this.lastY > rect.bottom - EDGE) delta = Math.ceil((this.lastY - (rect.bottom - EDGE)) / 4);
    if (!delta) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      if (!this.active) return;
      container.scrollTop += delta;
      this.update();
    });
  }

  private onPointerUp = (event: PointerEvent): void => {
    const pending = this.pending;
    if (!pending || event.pointerId !== pending.pointerId) return;
    const wasActive = this.active;
    const target = this.target;
    this.finish();
    if (!wasActive) return;
    event.preventDefault();
    // The pointerup of a drag must not also click the link under it (the click, if any, fires in this task).
    const suppress = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('click', suppress, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', suppress, true), 0);
    if (!target) return;
    if (pending.kind === 'repo' && 'sectionId' in target) this.host.dropRepo(Number(pending.id), target);
    if (pending.kind === 'section' && 'beforeSectionId' in target) this.host.dropSection(pending.id, target.beforeSectionId);
  };

  private onCancel = (): void => {
    this.finish();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.pending) {
      event.preventDefault();
      event.stopPropagation();
      this.finish();
    }
  };

  private finish(): void {
    const pending = this.pending;
    window.removeEventListener('pointermove', this.onPointerMove, true);
    window.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('pointercancel', this.onCancel, true);
    window.removeEventListener('keydown', this.onKeyDown, true);
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
    if (pending && this.active) {
      try {
        pending.source.releasePointerCapture(pending.pointerId);
      } catch {
        // already released
      }
      this.host.setDragging(pending.kind, pending.id, false);
    }
    this.ghost?.remove();
    this.line?.remove();
    this.ghost = null;
    this.line = null;
    this.host.highlightSection(null);
    this.pending = null;
    this.active = false;
    this.target = null;
  }

  destroy(): void {
    this.finish();
    this.root.removeEventListener('pointerdown', this.onPointerDown);
  }
}
