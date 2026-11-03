// Last step of `npm run package`: writes SUBMIT.html and SUBMIT.md into release/chrome-web-store-<version>/, with
// every dashboard field marked with the release it last changed in, so an update shows exactly what to change in the
// Developer Dashboard. Runs after the screenshots because the comparison includes the images.
//
// store/listing-history.json (committed) keeps one snapshot per packaged version (scripts/listing-history.mjs).
// Packaging the same version again replaces its snapshot.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { imageFiles, lineage, readHistory, record, snapshot, thumbnails, writeHistory } from './listing-history.mjs';
import { storeListing } from './store-listing.mjs';
import { checkLimits, renderHtml, renderMarkdown } from './submit-page.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, 'release', `chrome-web-store-${version}`);
const tabs = storeListing(version);
checkLimits(tabs);
const missing = imageFiles(tabs).filter((p) => !existsSync(join(out, p)));
if (missing.length) throw new Error(`Missing from ${out}: ${missing.join(', ')}. Run the whole \`npm run package\`.`);

const browser = await chromium.launch();
try {
  const historyFile = join(root, 'store', 'listing-history.json');
  const history = record(readHistory(historyFile), version, snapshot(tabs, await thumbnails(browser, out, imageFiles(tabs))));
  writeHistory(historyFile, history);
  const changes = lineage(history, version);
  writeFileSync(join(out, 'SUBMIT.html'), renderHtml(tabs, version, changes));
  writeFileSync(join(out, 'SUBMIT.md'), renderMarkdown(tabs, version, changes));
} finally {
  await browser.close();
}

console.log(`Store submission page -> ${join(out, 'SUBMIT.html')} (fields marked with the release they last changed in)`);
