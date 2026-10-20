// The Chrome Web Store submission, field by field, in the Developer Dashboard's order. Single source of truth for
// release/chrome-web-store-<version>/SUBMIT.html (copy buttons) and SUBMIT.md, written by scripts/store-assets.mjs.
//
// Field kinds:
//   text    paste `value` into the field (limit = the dashboard's character limit)
//   choice  pick `value` in a dropdown or radio group
//   file    upload the file(s) at `files` (paths relative to the submission folder)
//   checks  tick exactly the options marked true
//   info    nothing to enter (shown for orientation)

// Public product pages on levac.net, which the Chrome Web Store listing links to.
const SITE = 'https://levac.net/repo-navigator/';

const DESCRIPTION = `GitHub shows about ten "Top repositories" and hides the rest behind "Show more". GitHub Repo Navigator replaces that short list with every repository you can access, organized into your own sections.

WHERE IT SHOWS UP
• GitHub's ☰ menu (top-left of any github.com page)
• The left sidebar of the github.com dashboard
Nothing else on GitHub changes. If GitHub changes its layout in a way the extension does not recognise, GitHub's own list stays in place.

FEATURES
• Complete list: every repository your account can reach, read page by page from GitHub's official API: your own, your organizations', and ones you collaborate on.
• Your sections: create, rename, reorder, collapse. Drag repositories between sections, or move them with the keyboard. New repositories land in Uncategorized.
• Organize automatically: on first run it asks whether to start with suggested sections or one plain list. "Suggest sections" proposes sections from name patterns, owners, descriptions and languages. Edit the preview, apply, or undo.
• Back up and share: export your sections to a file and import them elsewhere.
• Fast filter across the whole list.
• Synced: your sections follow you to every Chrome where you use Chrome Sync, and another browser only has to click Connect.
• Guided setup: a checklist walks you through connecting, and checks every step for you.
• Light and dark themes that follow GitHub's. Full keyboard and screen reader support.

PRIVATE BY DESIGN
• Read-only access to repository metadata. It cannot read your code or change anything on GitHub.
• No server: it talks only to GitHub. Nothing is sent to the developer or anyone else.
• Tokens stay on your device and are never synced.

SETUP (about three minutes, once)
The extension signs in through a small GitHub App that you own, limited to read-only metadata. The settings page opens GitHub's form already filled in, tells you the one box to tick, then connects with a short code. More: ${SITE}`;

const TEST_INSTRUCTIONS = `A GitHub account is needed (any free account works). No test credentials are required from us: the extension signs in through the reviewer's own GitHub account with read-only access.

1. Install, then click the toolbar icon to open the settings page.
2. Follow "Getting started": it opens GitHub's New GitHub App form already filled in. Tick "Enable Device Flow", click "Create GitHub App", and paste the Client ID back into the settings page.
3. Click "Connect GitHub", enter the code shown at github.com/login/device, and click "Authorize".
4. Install the app on the account with "All repositories" (the guide links straight to it).
5. On github.com, open the ☰ menu (top-left) or the dashboard: the "Top repositories" list is replaced by the full list with sections. The first time, the list (and the settings page) asks "How do you want to start?": choose "Suggest sections" to see a preview (it can be undone).`;

export function storeListing(version) {
  return [
    {
      tab: 'Package',
      intro: 'Items → New item (first time) or Package → Upload new package (updates).',
      fields: [{ label: 'Upload package', kind: 'file', files: ['1-upload-this.zip'], note: `Version ${version}. The production build without the manifest "key" field, which the store rejects. Every update needs a higher version.` }],
    },
    {
      tab: 'Store listing',
      fields: [
        { label: 'Title', kind: 'info', value: 'GitHub Repo Navigator', note: 'Taken from the package (manifest name).' },
        { label: 'Summary', kind: 'info', value: 'Every GitHub repository you can access, organized into your own synced sections, in GitHub’s menu and dashboard.', note: 'Taken from the package (manifest description).' },
        { label: 'Description', required: true, kind: 'text', limit: 16000, value: DESCRIPTION },
        { label: 'Category', required: true, kind: 'choice', value: 'Developer Tools' },
        { label: 'Language', required: true, kind: 'choice', value: 'English' },
        { label: 'Store icon', required: true, kind: 'file', files: ['images/store-icon-128.png'], note: '128×128 PNG.' },
        { label: 'Global promo video', kind: 'info', value: '(leave empty)' },
        {
          label: 'Screenshots',
          required: true,
          kind: 'file',
          files: ['images/screenshots/1-menu-sections.png', 'images/screenshots/2-filter.png', 'images/screenshots/3-dashboard-sidebar.png', 'images/screenshots/4-suggest-sections.png', 'images/screenshots/5-setup.png'],
          note: 'Upload all five, in this order. Each is 1280×800, 24-bit PNG, made from a made-up sample account.',
        },
        { label: 'Small promo tile', kind: 'file', files: ['images/promo-tile-440x280.png'], note: '440×280.' },
        { label: 'Marquee promo tile', kind: 'info', value: '(leave empty)' },
        { label: 'Official URL', kind: 'info', value: '(leave as None)' },
        { label: 'Homepage URL', kind: 'text', value: SITE },
        { label: 'Support URL', kind: 'text', value: `${SITE}#support` },
        { label: 'Mature content', kind: 'choice', value: 'No (leave unticked)' },
      ],
    },
    {
      tab: 'Privacy',
      fields: [
        {
          label: 'Single purpose description',
          required: true,
          kind: 'text',
          limit: 1000,
          value: `Shows every GitHub repository the user can access, organized into the user's own sections, in place of GitHub's "Top repositories" lists in the github.com navigation menu and dashboard sidebar.`,
        },
        {
          label: 'storage justification',
          required: true,
          kind: 'text',
          limit: 1000,
          value:
            "Stores the user's sections (names, order, and which repository IDs each holds) in chrome.storage.sync so they follow the user to their other Chrome devices, together with the user's own GitHub App client ID (a public identifier) so another browser only has to sign in. On the device only (chrome.storage.local, restricted to the extension's own pages), stores the GitHub sign-in tokens and a cache of the repository list so the menu opens instantly and works when GitHub is briefly unreachable.",
        },
        {
          label: 'alarms justification',
          required: true,
          kind: 'text',
          limit: 1000,
          value:
            'Refreshes the repository list from GitHub periodically in the background so new repositories appear without the user doing anything, and resumes a GitHub sign-in that is in progress if Chrome suspends the service worker while the user is entering the code.',
        },
        {
          label: 'Host permission justification',
          required: true,
          kind: 'text',
          limit: 1000,
          value:
            'https://github.com/*: the content script displays the repository navigator inside github.com\'s navigation menu and dashboard sidebar, replacing only the "Top repositories" lists; the extension also uses GitHub\'s OAuth device flow on github.com (/login/device/code and /login/oauth/access_token) to sign in. https://api.github.com/*: reads the list of repositories the user can access and the GitHub App\'s installations through GitHub\'s official REST API, read-only. No other hosts are contacted.',
        },
        { label: 'Are you using remote code?', required: true, kind: 'choice', value: 'No, I am not using Remote code', note: 'All code ships in the package. No eval, remote scripts or WebAssembly.' },
        {
          label: 'What user data do you plan to collect from users now or in the future?',
          kind: 'checks',
          options: [
            ['Personally identifiable information', true, 'The GitHub login name and user ID, shown as "Connected as @name" and used to keep each connected account apart. The login name a github.com page is signed in as is compared with the connected accounts to show that account\'s list; it is not stored.'],
            ['Health information', false],
            ['Financial and payment information', false],
            ['Authentication information', true, 'GitHub access tokens, kept on the device and sent only to GitHub.'],
            ['Personal communications', false],
            ['Location', false],
            ['Web history', false],
            ['User activity', false],
            ['Website content', false, 'Repository names come from GitHub’s API, not from reading page content.'],
          ],
        },
        {
          label: 'I certify that the following disclosures are true',
          kind: 'checks',
          options: [
            ['I do not sell or transfer user data to third parties, outside of the approved use cases', true],
            ['I do not use or transfer user data for purposes that are unrelated to my item’s single purpose', true],
            ['I do not use or transfer user data to determine creditworthiness or for lending purposes', true],
          ],
        },
        { label: 'Privacy policy URL', required: true, kind: 'text', value: `${SITE}privacy.html`, note: 'Published on levac.net; the same policy is in PRIVACY.md in this folder.' },
      ],
    },
    {
      tab: 'Distribution',
      fields: [
        { label: 'Payments', kind: 'choice', value: 'Free of charge' },
        { label: 'Visibility', kind: 'choice', value: 'Public', note: 'Or Unlisted for a soft launch: only people with the link can install.' },
        { label: 'Distribution', kind: 'choice', value: 'All regions' },
      ],
    },
    {
      tab: 'Test instructions',
      fields: [
        { label: 'Test instructions', kind: 'text', limit: 5000, value: TEST_INSTRUCTIONS },
        { label: 'Username / Password', kind: 'info', value: '(leave empty: reviewers use their own GitHub account)' },
      ],
    },
    {
      tab: 'Submit',
      fields: [{ label: 'Submit for review', kind: 'info', value: 'Status → Submit for review. Review usually takes a few days; choose whether to publish automatically after approval.' }],
    },
  ];
}
