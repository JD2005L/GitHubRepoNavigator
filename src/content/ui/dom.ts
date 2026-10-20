import { ICONS, type IconName } from './icons';

/**
 * Tiny element builder. Every string becomes a text node or an attribute value; there is deliberately no
 * way to insert HTML, so repository names, owners and section names can never become markup.
 */
type Child = Node | string | number | null | undefined | false;
type Props = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'className') {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, className = 'grn-icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `${className} grn-icon-${name}`);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Text nodes and <mark> elements for `text.slice(start, end)`, where matches of `terms` are found in the whole
 * `text`. Lets a match that spans "owner/name" be highlighted although the two parts are styled separately.
 */
export function highlightRange(text: string, terms: string[], start = 0, end = text.length): Node[] {
  const lower = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at === -1) break;
      marks.push([at, at + term.length]);
      from = at + term.length;
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([m[0], m[1]]);
  }
  const nodes: Node[] = [];
  let pos = start;
  for (const [ms, me] of merged) {
    const s0 = Math.max(ms, start);
    const e0 = Math.min(me, end);
    if (e0 <= s0) continue;
    if (s0 > pos) nodes.push(document.createTextNode(text.slice(pos, s0)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(s0, e0);
    nodes.push(mark);
    pos = e0;
  }
  if (pos < end) nodes.push(document.createTextNode(text.slice(pos, end)));
  return nodes;
}

/** Highlights matches of `terms` in all of `text`. */
export function highlight(text: string, terms: string[]): Node[] {
  return highlightRange(text, terms);
}

export function formatRelative(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hours = Math.round(m / 60);
  if (hours < 24) return `${hours} h ago`;
  const d = Math.round(hours / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
