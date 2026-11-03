# Chrome Web Store submission

```bash
npm run check      # typecheck, lint, unit, build, browser tests
npm run package    # release/chrome-web-store-<version>/
```

`npm run package` builds one folder with everything the Developer Dashboard asks for:

| File | What it is |
|---|---|
| `SUBMIT.html` | Every dashboard field, tab by tab, under its exact label, with a **Copy** button and character count. Open it next to the dashboard. It lists the fields to update since the version the dashboard has (picker in the header), highlights them, and shows a line diff for changed text. |
| `SUBMIT.md` | The same content as Markdown, with a *Changed since* list for the previous release. |
| `1-upload-this.zip` | The package: the production build without the manifest `key` (the store rejects it and assigns its own ID). |
| `PRIVACY.md` | The privacy policy (the listing links to the published copy at levac.net/repo-navigator/privacy.html). |
| `images/store-icon-128.png` | Store icon. |
| `images/promo-tile-440x280.png` | Small promo tile. |
| `images/screenshots/` | Five 1280×800 screenshots from a made-up sample account (`e2e/store/screenshots.store.ts`). |

The field values (listing description, single purpose, permission justifications, data-usage answers, test
instructions) live in [`scripts/store-listing.mjs`](../scripts/store-listing.mjs). Edit them there; the build fails
if a value exceeds its field's character limit.

For an update: bump `version` in `package.json`, run both commands above, and upload the new zip under
**Package → Upload new package**. Then update only the fields SUBMIT.html lists as changed.

What changed comes from [`store/listing-history.json`](../store/listing-history.json) (commit it with the release):
one snapshot per packaged version of every field's content and, for images, a small grayscale thumbnail compared
with a tolerance (re-rendering an unchanged screenshot is never byte-identical). `scripts/store-submit.mjs` records
the snapshot and writes SUBMIT.html last, after the screenshots exist. Packaging the same version again replaces its
snapshot. The history was seeded from the 1.0.0 to 1.3.0 submission folders, with 1.3.0's text as submitted
(the shortened test instructions came after it).
