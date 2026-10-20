// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { candidateDialogs, findCloseButton, findLoadingSlot, findTopRepositories, headingText, isGlobalDrawer, isRepoLink, scoreDrawer } from '../../src/content/drawer';
import { as202605, asLoading, asUnknownMarkup, drawerDialog, legacyDrawerHtml, loadFixture, topReposGroup, withTeamsGroup } from '../helpers/dom';

describe('drawer detection', () => {
  beforeEach(() => loadFixture());

  it('recognises the 2026-10 React drawer from several independent signals', () => {
    const dialog = drawerDialog();
    const score = scoreDrawer(dialog);
    expect(score.signals).toEqual(['D1:label', 'D2:left', 'D3:nav', 'D4:portal']);
    expect(isGlobalDrawer(dialog)).toBe(true);
  });

  it('finds exactly the Top repositories group and nothing else', () => {
    const match = findTopRepositories(drawerDialog())!;
    expect(match.container).toBe(topReposGroup());
    expect(match.signals).toEqual(['S1:heading', 'S2:search-hook', 'S3:repo-links', 'S4:show-more']);
    expect(match.repoLinks).toBe(7);
    expect(match.container.querySelector('[data-testid^="side-nav-menu-item-"]')).toBeNull();
  });

  it('reads heading text without tooltip and button noise', () => {
    expect(headingText(topReposGroup().querySelector('h3')!)).toBe('top repositories');
    expect(topReposGroup().querySelector('h3')!.textContent.replace(/\s+/g, '')).toContain('Searchforrepositories');
  });

  it('survives the 2026-05 build: other hashes, fewer hooks, capitalised label', () => {
    loadFixture(as202605);
    const dialog = drawerDialog();
    expect(isGlobalDrawer(dialog)).toBe(true);
    const match = findTopRepositories(dialog)!;
    expect(match).not.toBeNull();
    expect(match.container.textContent).toContain('Top repositories');
    expect(match.container.textContent).not.toContain('Explore');
  });

  it('does nothing while GitHub is still loading its list', () => {
    loadFixture(asLoading);
    expect(isGlobalDrawer(drawerDialog())).toBe(true);
    expect(findTopRepositories(drawerDialog())).toBeNull();
  });

  it('never confuses a Teams group that reuses the same hooks', () => {
    loadFixture(withTeamsGroup);
    const match = findTopRepositories(drawerDialog())!;
    expect(match.container.hasAttribute('data-test-teams')).toBe(false);
    expect(match.container.textContent).toContain('Top repositories');
  });

  it('still recognises the section while GitHub\u2019s own repository search is open', () => {
    loadFixture((doc) => {
      const group = topReposGroup(doc);
      const h3 = group.querySelector('h3')!;
      h3.querySelector('div')!.remove(); // assume the title is swapped out too; only the search hooks remain
      const button = h3.querySelector('button')!;
      button.setAttribute('data-testid', 'dynamic-side-panel-items-close-search-button');
      const tooltip = h3.querySelector('[popover]')!;
      tooltip.textContent = 'Close search';
      const input = doc.createElement('input');
      input.setAttribute('data-testid', 'dynamic-side-panel-items-search-input');
      input.setAttribute('aria-label', 'Search for repositories');
      group.querySelector('ul')!.prepend(Object.assign(doc.createElement('li'), {}));
      group.querySelector('ul li')!.appendChild(input);
    });
    const match = findTopRepositories(drawerDialog())!;
    expect(match.container.getAttribute('data-component')).toBe('ActionList.Group');
    expect(match.container.querySelector('[data-testid="dynamic-side-panel-items-search-input"]')).toBeTruthy();
    expect(match.container.querySelector('[data-testid^="side-nav-menu-item-"]')).toBeNull();
    expect(match.signals).toContain('S2:search-hook');
  });

  it('finds GitHub\u2019s loading slot and the close button', () => {
    loadFixture(asLoading);
    const slot = findLoadingSlot(drawerDialog())!;
    expect(slot.signals).toEqual(['L:loader']);
    expect(slot.container.querySelector('[data-testid="dynamic-side-content-loader"]')).toBeTruthy();
    expect(findCloseButton(drawerDialog())!.getAttribute('data-component')).toBe('IconButton');
  });

  it('fails open on unknown markup (links but no heading or hooks)', () => {
    loadFixture(asUnknownMarkup);
    expect(findTopRepositories(drawerDialog())).toBeNull();
  });

  it('handles the legacy server-rendered drawer through the fallback walk', () => {
    loadFixture((doc) => {
      doc.getElementById('__primerPortalRoot__')!.replaceChildren();
      doc.body.insertAdjacentHTML('beforeend', legacyDrawerHtml());
    });
    const dialog = candidateDialogs(document).find((d) => d.tagName === 'DIALOG')!;
    expect(isGlobalDrawer(dialog)).toBe(true);
    const match = findTopRepositories(dialog)!;
    expect(match.container.className).toBe('legacy-repos');
    expect(match.repoLinks).toBe(2);
  });

  it('ignores the dashboard sidebar and other dialogs', () => {
    loadFixture((doc) => {
      doc.getElementById('__primerPortalRoot__')!.replaceChildren();
      doc.body.insertAdjacentHTML(
        'beforeend',
        `<aside class="dashboard-sidebar" data-testid="dashboard-repositories"><h2>Top repositories</h2><button data-testid="dynamic-side-panel-items-search-button" aria-label="Search for repositories"></button><ul><li><a data-testid="dynamic-side-panel-items-item" href="/octocat/Hello-World">octocat/Hello-World</a></li></ul><button data-testid="dynamic-side-panel-items-show-more">Show more</button></aside>
         <div role="dialog" aria-modal="true" aria-label="Create new repository"><h3>Top repositories</h3><a href="/octocat/x">x</a></div>`,
      );
    });
    expect(candidateDialogs(document).filter(isGlobalDrawer)).toHaveLength(0);
  });

  it('classifies repository links by shape, not by text', () => {
    const a = (href: string) => Object.assign(document.createElement('a'), { href });
    for (const href of ['/octocat/Hello-World', 'https://github.com/a-b/c.d_e', '/user/repo/']) expect(isRepoLink(a(href), 'https://github.com')).toBe(true);
    for (const href of ['/orgs/x', '/settings/profile', '/octocat', '/octocat/repo/issues', 'https://evil.example/a/b', '/marketplace/x', 'javascript:alert(1)'])
      expect(isRepoLink(a(href), 'https://github.com')).toBe(false);
  });
});
