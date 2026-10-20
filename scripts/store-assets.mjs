// Collects everything the Chrome Web Store submission needs into one folder:
//   release/chrome-web-store-<version>/
//     1-upload-this.zip            the package (built by `node scripts/build.mjs --store`)
//     SUBMIT.html / SUBMIT.md      every dashboard field under its exact label, ready to paste (Copy buttons in .html)
//     PRIVACY.md                   the privacy policy (also published in the repository)
//     images/store-icon-128.png    store icon
//     images/promo-tile-440x280.png  small promo tile (rendered here with Playwright)
//     images/screenshots/          five 1280x800 screenshots (sample data), made by e2e/store/screenshots.store.ts
// Run through `npm run package`, after the store build.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { storeListing } from './store-listing.mjs';
import { checkLimits, renderHtml, renderMarkdown } from './submit-page.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const zip = join(root, 'release', `github-repo-navigator-${version}.zip`);
const icon = join(root, 'dist-store', 'icons', 'icon128.png');
if (!existsSync(zip) || !existsSync(icon)) throw new Error('Run the store build first: node scripts/build.mjs --store');

const out = join(root, 'release', `chrome-web-store-${version}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'images', 'screenshots'), { recursive: true });

renameSync(zip, join(out, '1-upload-this.zip')); // moved, so release/ holds only this folder
copyFileSync(icon, join(out, 'images', 'store-icon-128.png'));
copyFileSync(join(root, 'PRIVACY.md'), join(out, 'PRIVACY.md'));
// images/screenshots/ is filled by `npm run package:screenshots` (part of `npm run package`).

// The submission, field by field (scripts/store-listing.mjs): a page with copy buttons, and the same as Markdown.
const tabs = storeListing(version);
checkLimits(tabs);
writeFileSync(join(out, 'SUBMIT.html'), renderHtml(tabs, version));
writeFileSync(join(out, 'SUBMIT.md'), renderMarkdown(tabs, version));

// Small promo tile, 440x280.
const iconData = readFileSync(icon).toString('base64');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;width:440px;height:280px;background:linear-gradient(135deg,#0d1117 0%,#161b22 60%,#1f2a3a 100%);font-family:"Segoe UI",system-ui,-apple-system,sans-serif;color:#f0f6fc;display:flex;align-items:center;gap:22px;padding:0 30px;box-sizing:border-box;overflow:hidden}
img{width:96px;height:96px;flex:none;filter:drop-shadow(0 6px 16px rgba(0,0,0,.5))}
h1{font-size:27px;line-height:1.15;margin:0 0 10px;font-weight:700}
p{margin:0;font-size:15px;line-height:1.4;color:#9198a1}
b{color:#4493f8;font-weight:600}
</style></head><body><img src="data:image/png;base64,${iconData}" alt=""><div><h1>GitHub Repo Navigator</h1><p>Every repository you can access, <b>organized into your own sections</b>, right in GitHub's menu.</p></div></body></html>`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await page.setContent(html);
  await page.screenshot({ path: join(out, 'images', 'promo-tile-440x280.png') });
} finally {
  await browser.close();
}

console.log(`Chrome Web Store submission folder -> ${out}`);
