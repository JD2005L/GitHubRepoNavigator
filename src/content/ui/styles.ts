/**
 * Shadow-root styles. Colors come from GitHub's Primer custom properties, which inherit into the shadow root,
 * so the navigator follows every GitHub theme (light, dark, dimmed, high contrast, colorblind) automatically.
 * Each token falls back to the legacy Primer name and then to a literal for the host's resolved color mode.
 * Density mirrors Primer's ActionList as used in the global navigation drawer (32px rows, 14px text).
 * Animations are unconditional (by design, as in force-motion.js: never gate on reduced motion).
 */
export const STYLES = `
:host {
  all: initial;
  display: block;
  /* all:initial resets color-scheme; inherit GitHub's so native controls (caret, scrollbars) match dark mode. */
  color-scheme: inherit;
  font-family: inherit;
  font-size: var(--text-body-size-medium, 14px);
  line-height: 20px;
  color: var(--fgColor-default, var(--color-fg-default, var(--grn-fallback-fg)));
  --grn-fallback-fg: #1f2328;
  --grn-fallback-muted: #59636e;
  --grn-fallback-border: #d1d9e0;
  --grn-fallback-hover: rgba(129, 139, 152, 0.15);
  --grn-fallback-active: rgba(129, 139, 152, 0.24);
  --grn-fallback-accent: #0969da;
  --grn-fallback-accent-muted: rgba(84, 174, 255, 0.4);
  --grn-fallback-bg: #ffffff;
  --grn-fallback-danger: #d1242f;
  --grn-fallback-attention-bg: #fff8c5;
  --grn-fallback-attention-border: rgba(212, 167, 44, 0.4);
  --grn-fg: var(--fgColor-default, var(--color-fg-default, var(--grn-fallback-fg)));
  --grn-muted: var(--fgColor-muted, var(--color-fg-muted, var(--grn-fallback-muted)));
  --grn-border: var(--borderColor-muted, var(--color-border-muted, var(--grn-fallback-border)));
  --grn-hover: var(--control-transparent-bgColor-hover, var(--color-action-list-item-default-hover-bg, var(--grn-fallback-hover)));
  --grn-active: var(--control-transparent-bgColor-active, var(--color-action-list-item-default-active-bg, var(--grn-fallback-active)));
  --grn-accent: var(--fgColor-accent, var(--color-accent-fg, var(--grn-fallback-accent)));
  --grn-focus: var(--focus-outlineColor, var(--color-accent-fg, var(--grn-fallback-accent)));
  --grn-accent-muted: var(--bgColor-accent-muted, var(--color-accent-subtle, var(--grn-fallback-accent-muted)));
  --grn-bg: var(--overlay-bgColor, var(--bgColor-default, var(--color-canvas-overlay, var(--grn-fallback-bg))));
  --grn-danger: var(--fgColor-danger, var(--color-danger-fg, var(--grn-fallback-danger)));
  --grn-attention-bg: var(--bgColor-attention-muted, var(--color-attention-subtle, var(--grn-fallback-attention-bg)));
  --grn-attention-border: var(--borderColor-attention-muted, var(--color-attention-muted, var(--grn-fallback-attention-border)));
  --grn-radius: var(--borderRadius-medium, 6px);
  --grn-shadow: var(--shadow-floating-small, 0 1px 3px rgba(31, 35, 40, 0.12), 0 8px 24px rgba(66, 74, 83, 0.12));
}
:host([data-grn-theme="dark"]) {
  --grn-fallback-fg: #f0f6fc;
  --grn-fallback-muted: #9198a1;
  --grn-fallback-border: #3d444d;
  --grn-fallback-hover: rgba(101, 108, 118, 0.2);
  --grn-fallback-active: rgba(101, 108, 118, 0.3);
  --grn-fallback-accent: #4493f8;
  --grn-fallback-accent-muted: rgba(56, 139, 253, 0.4);
  --grn-fallback-bg: #151b23;
  --grn-fallback-danger: #f85149;
  --grn-fallback-attention-bg: rgba(187, 128, 9, 0.15);
  --grn-fallback-attention-border: rgba(187, 128, 9, 0.4);
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.grn { position: relative; padding: 0; margin: 0; }
.grn-layer { position: absolute; inset: 0; pointer-events: none; z-index: 5; overflow: visible; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.grn-icon { width: 16px; height: 16px; fill: currentColor; flex: none; vertical-align: text-bottom; }

/* Header */
.grn-header { display: flex; align-items: center; gap: 4px; padding: 6px 8px 2px; min-height: 32px; }
.grn-title { margin: 0; font-size: 12px; font-weight: 600; line-height: 18px; color: var(--grn-muted); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grn-title-count { font-weight: 400; margin-left: 4px; }
.grn-icon-btn {
  display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; margin: 0;
  border: 0; border-radius: var(--grn-radius); background: transparent; color: var(--grn-muted);
  cursor: pointer; font: inherit; flex: none;
  transition: background-color 80ms ease, color 80ms ease;
}
.grn-icon-btn:hover { background: var(--grn-hover); color: var(--grn-fg); }
.grn-icon-btn:active { background: var(--grn-active); }
.grn-icon-btn[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.grn-icon-btn.is-busy .grn-icon-sync { animation: grn-spin 900ms linear infinite; }
@keyframes grn-spin { to { transform: rotate(360deg); } }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--grn-focus); outline-offset: -2px; border-radius: var(--grn-radius); }

/* Search */
.grn-search { position: relative; margin: 4px 8px 6px; }
.grn-search .grn-icon { position: absolute; left: 8px; top: 8px; color: var(--grn-muted); pointer-events: none; }
.grn-search input {
  width: 100%; height: 32px; padding: 5px 30px 5px 30px; margin: 0;
  font: inherit; font-size: 14px; line-height: 20px; color: var(--grn-fg);
  background: var(--bgColor-default, var(--color-canvas-default, var(--grn-fallback-bg)));
  border: 1px solid var(--borderColor-default, var(--color-border-default, var(--grn-fallback-border)));
  border-radius: var(--grn-radius); outline: none;
  transition: border-color 80ms ease, box-shadow 80ms ease;
}
.grn-search input::placeholder { color: var(--grn-muted); opacity: 1; }
.grn-search input:focus { border-color: var(--grn-focus); box-shadow: inset 0 0 0 1px var(--grn-focus); }
.grn-search input::-webkit-search-cancel-button { display: none; }
.grn-search .grn-clear { position: absolute; right: 2px; top: 2px; }

/* Banners */
.grn-banner {
  display: flex; gap: 8px; align-items: flex-start; margin: 4px 8px 6px; padding: 8px 10px;
  font-size: 12px; line-height: 18px; color: var(--grn-fg);
  background: var(--grn-attention-bg); border: 1px solid var(--grn-attention-border); border-radius: var(--grn-radius);
  animation: grn-fade-in 160ms ease-out;
}
.grn-banner .grn-icon { margin-top: 1px; color: var(--grn-muted); }
.grn-banner-body { flex: 1 1 auto; min-width: 0; }
.grn-link-btn { padding: 0; margin: 0; border: 0; background: none; color: var(--grn-accent); font: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
@keyframes grn-fade-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }

/* Sections */
.grn-sections, .grn-repos { list-style: none; margin: 0; padding: 0; }
.grn-section { margin: 0 0 2px; position: relative; border-radius: var(--grn-radius); transition: box-shadow 120ms ease, background-color 120ms ease; }
.grn-section.is-drop-target { background: var(--grn-accent-muted); box-shadow: inset 0 0 0 1px var(--grn-focus); }
.grn-section.is-dragging { opacity: 0.45; }
.grn-section-header { display: flex; align-items: center; gap: 2px; padding: 0 8px 0 0; min-height: 32px; border-radius: var(--grn-radius); }
.grn-section-header:hover .grn-grip, .grn-section-header:focus-within .grn-grip { opacity: 1; }
.grn-section-toggle {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 8px; margin: 0; border: 0; background: transparent; border-radius: var(--grn-radius);
  font: inherit; font-size: 12px; font-weight: 600; line-height: 18px; color: var(--grn-muted); cursor: pointer; text-align: left;
}
.grn-section-toggle:hover { background: var(--grn-hover); color: var(--grn-fg); }
.grn-chevron { transition: transform 160ms ease; }
.grn-section-toggle[aria-expanded="false"] .grn-chevron { transform: rotate(-90deg); }
.grn-section-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grn-section-count { font-weight: 400; margin-left: auto; padding-left: 6px; font-variant-numeric: tabular-nums; }
.grn-section-auto { font-weight: 400; font-style: italic; }
.grn-rename { flex: 1 1 auto; min-width: 0; height: 28px; margin: 2px 0; padding: 3px 8px; font: inherit; font-size: 13px; color: var(--grn-fg);
  background: var(--bgColor-default, var(--color-canvas-default, var(--grn-fallback-bg))); border: 1px solid var(--grn-focus); border-radius: var(--grn-radius); outline: none; }
.grn-grip { display: inline-grid; place-items: center; width: 16px; height: 28px; color: var(--grn-muted); opacity: 0; cursor: grab; flex: none; touch-action: none; transition: opacity 80ms ease; }
.grn-repos { overflow: hidden; }
.grn-repos.is-expanding { animation: grn-expand 180ms ease-out; }
@keyframes grn-expand { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

/* Repository rows */
.grn-repo { position: relative; display: flex; align-items: center; border-radius: var(--grn-radius); min-height: 32px; transition: opacity 120ms ease, background-color 80ms ease; }
.grn-repo:hover { background: var(--grn-hover); }
.grn-repo:hover .grn-grip, .grn-repo:focus-within .grn-grip, .grn-repo:hover .grn-row-menu, .grn-repo:focus-within .grn-row-menu { opacity: 1; }
.grn-repo.is-dragging { opacity: 0.4; }
.grn-repo.is-moved { animation: grn-flash 700ms ease-out; }
@keyframes grn-flash { from { background: var(--grn-accent-muted); } to { background: transparent; } }
.grn-repo .grn-grip { position: absolute; left: -2px; top: 2px; width: 12px; }
.grn-repo-link {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; height: 32px; padding: 6px 8px 6px 12px;
  color: var(--grn-fg); text-decoration: none; border-radius: var(--grn-radius); cursor: pointer; user-select: none; -webkit-user-drag: none;
}
.grn-repo-link:hover { text-decoration: none; }
.grn-avatar { width: 16px; height: 16px; border-radius: 50%; flex: none; box-shadow: 0 0 0 1px var(--avatar-borderColor, rgba(31, 35, 40, 0.15)); background: var(--grn-hover); -webkit-user-drag: none; }
.grn-avatar.is-org { border-radius: 4px; }
.grn-repo-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grn-repo-owner { color: var(--grn-muted); }
.grn-repo-text mark { background: var(--grn-accent-muted); color: inherit; border-radius: 2px; }
.grn-badge { color: var(--grn-muted); display: inline-flex; }
.grn-badge .grn-icon { width: 12px; height: 12px; }
.grn-row-menu { opacity: 0; margin-right: 2px; width: 24px; height: 24px; transition: opacity 80ms ease, background-color 80ms ease; }
.grn-row-menu[aria-expanded="true"] { opacity: 1; }
.grn-empty { padding: 6px 12px 8px 32px; font-size: 12px; color: var(--grn-muted); }
.grn-more { padding: 2px 12px 6px 32px; font-size: 12px; color: var(--grn-muted); }

/* Touch screens have no hover: keep the drag grip and the move button visible. */
@media (hover: none) {
  .grn-grip, .grn-row-menu { opacity: 1; }
}

/* Footer */
.grn-footer { display: flex; align-items: center; gap: 8px; padding: 4px 8px 8px 12px; font-size: 12px; color: var(--grn-muted); }
.grn-footer-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grn-new-section { display: flex; gap: 4px; align-items: center; padding: 2px 8px 4px 8px; }

/* Prompt (GitHub's own list stays visible below) */
.grn-prompt { margin: 4px 8px 8px; padding: 10px 12px; border: 1px solid var(--grn-border); border-radius: var(--grn-radius); font-size: 12px; line-height: 18px; animation: grn-fade-in 160ms ease-out; }
.grn-prompt strong { display: block; font-size: 13px; color: var(--grn-fg); margin-bottom: 2px; }
.grn-prompt p { margin: 0 0 8px; color: var(--grn-muted); }
.grn-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; font: inherit; font-size: 12px; font-weight: 500;
  color: var(--button-default-fgColor-rest, var(--grn-fg)); background: var(--button-default-bgColor-rest, var(--grn-hover));
  border: 1px solid var(--button-default-borderColor-rest, var(--grn-border)); border-radius: var(--grn-radius); cursor: pointer; }
.grn-btn:hover { background: var(--button-default-bgColor-hover, var(--grn-active)); }
.grn-btn-primary { color: var(--button-primary-fgColor-rest, #fff); background: var(--button-primary-bgColor-rest, var(--grn-accent)); border-color: var(--button-primary-borderColor-rest, transparent); }
.grn-btn-primary:hover { background: var(--button-primary-bgColor-hover, var(--grn-accent)); }
.grn-start { margin: 4px 8px 8px; padding: 10px 12px; border: 1px solid var(--grn-accent); border-radius: var(--grn-radius); font-size: 12px; line-height: 18px; animation: grn-fade-in 160ms ease-out; }
.grn-start strong { display: block; font-size: 13px; color: var(--grn-fg); margin-bottom: 2px; }
.grn-start p { margin: 0 0 8px; color: var(--grn-muted); }
.grn-start-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.grn-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 600; letter-spacing: 0.06em; }

/* Menus */
.grn-menu {
  position: absolute; z-index: 10; min-width: 200px; max-width: 280px; max-height: 320px; overflow: auto; padding: 6px 0; margin: 0;
  background: var(--grn-bg); color: var(--grn-fg); border: 1px solid var(--grn-border); border-radius: 12px; box-shadow: var(--grn-shadow);
  font-size: 14px; line-height: 20px; list-style: none; animation: grn-pop 120ms ease-out; pointer-events: auto;
}
@keyframes grn-pop { from { opacity: 0; transform: scale(0.98) translateY(-2px); } to { opacity: 1; transform: none; } }
.grn-menu-item { display: flex; gap: 8px; align-items: flex-start; width: calc(100% - 12px); margin: 0 6px; padding: 6px 8px; border: 0; border-radius: var(--grn-radius); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.grn-menu-item:hover, .grn-menu-item:focus-visible { background: var(--grn-hover); outline: none; }
.grn-menu-item[aria-disabled="true"] { color: var(--grn-muted); cursor: not-allowed; }
.grn-menu-item[aria-disabled="true"]:hover { background: transparent; }
.grn-menu-item.is-danger:not([aria-disabled="true"]) { color: var(--grn-danger); }
.grn-menu-item .grn-icon { margin-top: 2px; color: var(--grn-muted); }
.grn-menu-label { display: block; }
.grn-menu-hint { display: block; font-size: 12px; line-height: 16px; color: var(--grn-muted); margin-top: 2px; }
.grn-menu-sep { height: 1px; margin: 6px 0; background: var(--grn-border); }
.grn-menu-heading { padding: 4px 14px 2px; font-size: 12px; font-weight: 600; color: var(--grn-muted); }

/* Drag feedback */
.grn-ghost { position: absolute; left: 0; top: 0; max-width: 240px; padding: 4px 10px; font-size: 13px; line-height: 20px; color: var(--grn-fg);
  background: var(--grn-bg); border: 1px solid var(--grn-border); border-radius: var(--grn-radius); box-shadow: var(--grn-shadow);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; will-change: transform; }
.grn-drop-line { position: absolute; left: 8px; right: 8px; top: 0; height: 2px; border-radius: 1px; background: var(--grn-focus); will-change: transform; }
.grn-drop-line::before { content: ""; position: absolute; left: -3px; top: -3px; width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--grn-focus); background: var(--grn-bg); }
`;
