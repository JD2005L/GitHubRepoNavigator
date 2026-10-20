# Privacy policy: GitHub Repo Navigator

*Last updated: 2026-10-13*

GitHub Repo Navigator is a Chrome extension that shows every GitHub repository you can access, organized into
your own sections, in GitHub's ☰ menu and on the github.com dashboard. This policy explains what it handles and
where that data goes.

**In short:** the extension has no server and sends nothing to its developer or any third party. It talks only to
GitHub, with read-only access to repository metadata, and keeps its data in your own browser.

## What the extension accesses

| Data | Where it comes from | Why |
|---|---|---|
| Your GitHub login name | GitHub's API, after you connect | To show who is connected and to recognise your own account. |
| The login name of the account a github.com page is signed in as | The page itself (GitHub names it in a `user-login` tag) | To show that account's repositories and sections when you connect more than one account. Compared with your connected accounts and not stored. |
| Your GitHub user ID | GitHub's API, after you connect | To keep each connected account's data apart, and to record which account the first set of synced sections belongs to. |
| GitHub access and refresh tokens | GitHub's device-flow sign-in, which you start | To read your repository list. |
| Repository metadata: ID, owner, name, owner avatar URL, visibility, archived/fork flags, last push time | GitHub's API | To show and organize your repositories. |
| GitHub App installations: account name and type, whether all or selected repositories are shared | GitHub's API | To tell you which accounts the app can see and what to fix. |
| Repository descriptions, primary languages and topics | GitHub's API, **only when you click *Suggest sections*** | To build the suggestion preview. Used once, never stored. |
| Your sections: names, order, collapsed state, and which repository IDs each holds | You | Your organization of the list. |

The extension's GitHub access is **read-only repository metadata**. It cannot read code, issues, pull requests or
any other content, and it cannot change anything on GitHub.

Apart from the signed-in login name above, it does not read GitHub's web pages for data. It does not use GitHub's
cookies, and does not collect browsing history, analytics or usage statistics.

## Where data is stored

- **This device only** (`chrome.storage.local`, restricted to the extension's own pages and background worker):
  tokens, your login name, the repository list and its cache metadata, kept separately for each GitHub account you
  connect. Content scripts running on github.com cannot read this area.
- **Chrome Sync** (`chrome.storage.sync`, only if you use Chrome Sync): your sections, their order and collapsed
  state, and the repository IDs in each; your GitHub App's client ID (a public identifier, not a secret) so another
  browser only has to connect; and whether you answered "How do you want to start?". Each connected GitHub account
  has its own sections, filed under its GitHub user ID. No tokens, names, descriptions or other repository details
  are synced.
  Chrome Sync is operated by Google under Google's privacy policy.
- **Files you choose to export** (*Export sections*): your sections plus each listed repository's ID and
  `owner/name`, saved where you choose.

## Where data is sent

Only to GitHub (`github.com` for sign-in, `api.github.com` for the repository list), over HTTPS, as part of the
features described above. The extension has no backend server, and no data is sent to the extension's developer or
to any other party. Data is never sold or used for advertising, credit or any purpose unrelated to the extension's
single purpose.

## Your control

- **Disconnect** (settings page, per account) deletes that account's tokens and cached repository list from that
  device.
- **Revoke** the extension's GitHub App at <https://github.com/settings/apps/authorizations> to invalidate its
  tokens everywhere.
- **Reset sections** (settings page) deletes your synced sections on every device.
- **Uninstalling** the extension makes Chrome delete its local data.

## Changes

Changes to this policy are published at <https://levac.net/repo-navigator/privacy.html>, with the date above
updated.

## Contact

Questions: James@Levac.net, or the contact form at <https://levac.net/#contact>.
