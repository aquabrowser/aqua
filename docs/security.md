# Aqua security details

How Aqua stores and protects your data. Everything here is checked against the code in this repository.

## The vault

All of Aqua's data lives in one SQLite file, `aqua.db`.

```
master password
   │  Argon2id v1.3: 128 MiB memory, 4 passes, 4 lanes, random 16-byte salt
   ▼
key-encryption key, 256 bit        exists only while unlocking
   │  AES-256-GCM unwrap
   ▼
data key, 256 bit, random          stored only in wrapped form
   ├─ AES-256-GCM ──▶ every record in aqua.db
   └─ HKDF-SHA256 ──▶ purpose keys, e.g. the HMAC key for site-storage row ids
```

- The password is Unicode-normalised (NFC) before derivation. Argon2id runs in a worker thread (hash-wasm) and takes about 0.5 s on a current desktop CPU. Minimum length: 8 characters.
- Record format: 1 format byte, 96-bit random nonce, 128-bit GCM tag, ciphertext. Every write gets a new nonce. The additional authenticated data names the record's slot (for example `aqua/v1/history/<id>`), so a record moved or replayed into another slot fails authentication.
- Sealed: settings, history (one row per visit), bookmarks, open tabs, the downloads list, site permissions, external-app grants, New Tab shortcuts and picture, cookies and localStorage.
- Plaintext, needed by the lock screen: the vault header (Argon2id parameters, salt, wrapped data key, timestamps), the wrong-password counter, theme and dark style, window position and size.
- SQLite runs with `secure_delete=ON`, WAL journal, `synchronous=FULL`.
- Changing the password re-wraps the data key; nothing else is re-encrypted. There is no recovery key and no server.
- Wrong passwords: after the third, a 5 s wait that doubles per failure up to 5 minutes, persisted in `aqua.db`. A copied `aqua.db` is slowed by Argon2id alone.
- Auto-lock after 1, 5, 15 (default), 30 or 60 minutes idle, or never, and when Windows locks or sleeps. Locking hides the window, writes pending records and zeroes the data key and the keys derived from it. Open pages, their cookies and records already decrypted stay in memory until Aqua quits.
- History row ids are 128 random bits, so the one plaintext column of a visit carries no time.
- An error that reaches the main process uncaught locks an open vault (the key is zeroed) and shows a short notice with no details. Code: `installErrorGuards` in `src/main/index.ts`.
- Wipe: Settings only, while unlocked, after typing WIPE. The profile folder is emptied at the next launch, before anything opens it.

Code: `src/main/storage/crypto.ts`, `src/main/storage/kdf.ts`, `src/main/storage/database.ts`, `src/main/services/vault.ts`.

## In-memory browsing

- Regular windows share one in-memory partition (`aqua-browsing`); each private window gets its own. Cookies, localStorage, IndexedDB, cache and service workers stay in RAM.
- Cookies are copied into the vault 1.5 s after a burst of changes (at least every 10 s) and on quit, and restored at unlock before the first page loads. HttpOnly, Secure, SameSite, host-only and `__Host-` cookies are recreated exactly. Code: `src/main/services/cookie-jar.ts`.
- First-party localStorage is restored by the tab preload before page scripts run and sealed into the vault as it changes. Row ids are HMAC-SHA256 of the origin. Code: `src/main/services/site-storage.ts`.
- Chromium's default (persistent) session refuses all web traffic.
- On disk in the profile folder: `aqua.db`, the filter list cache, Chromium's GPU shader caches, `Local State` and the empty stores Chromium creates for the unused default session.
- Outside the profile, installed copies only: a downloaded update's installer in `%LOCALAPPDATA%\aqua-browser-updater`, until it is installed.
- `logs/main.log` (and `main.old.log`, 512 KiB each at most), only if an error reaches the main process uncaught: its stack trace, with every address replaced by `<url>` and the home folder by `~`. Code: `src/main/lib/error-log.ts`.
- Versions before in-memory browsing left visited hosts in the default session's `Network Persistent State`, `TransportSecurity` and `DIPS`. Aqua overwrites these with random bytes and deletes them at every start, before Chromium opens them. Code: `src/main/services/legacy-profile.ts`.
- A packaged Aqua refuses to start with `--remote-debugging-port`, `--remote-debugging-pipe` or `--remote-debugging-address`. Electron fuses disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`.

Check it yourself (quit Aqua first; replace `youtube.com` with a site you visited):

```powershell
Get-ChildItem "$env:APPDATA\aqua-browser" -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object FullName -notmatch '\\filters\\' |
  Select-String -SimpleMatch -List 'youtube.com' | Select-Object Path
```

## Blocker

- `@ghostery/adblocker` 2.18.2 (MPL-2.0) with uBlock Origin's filter lists: uBlock filters (ads, badware, privacy, quick fixes, unbreak), EasyList, EasyPrivacy, Peter Lowe's list, Online Malicious URL Blocklist. Cookie-notice and annoyance lists are optional.
- Network requests are cancelled in `session.webRequest`; redirect resources are served from `aqua-resource://<random host per run>/`; `$csp=` filters add a header.
- Element-hiding CSS and scriptlets are injected before page scripts (`executeInMainWorld`).
- Lists ship with Aqua and refresh every 4 days via Node's `fetch` (no cookies). The scriptlets and redirect resources (`resources.json`) are code that runs in pages, so they ship with Aqua only and are never downloaded.
- Not supported compared with uBlock Origin: element picker, logger, dynamic filtering, `$popup` filters, procedural cosmetic filters, HTML filtering.

## Network requests Aqua makes on its own

| What                                       | When                                         | Where                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Filter list refresh                        | every 4 days                                 | ublockorigin.github.io, ublockorigin.pages.dev, cdn.jsdelivr.net, pgl.yoyo.org, curbengh.github.io, malware-filter.gitlab.io, malware-filter.pages.dev |
| Favicons (New Tab, bookmarks bar, History) | when shown                                   | the site each icon belongs to, without cookies                                                                                                         |
| New Tab picture from a URL                 | once, when set                               | the address entered                                                                                                                                    |
| Update check (installed copies only)       | 15 s after start, and on "Check for updates" | github.com (the release feed, `latest.yml`, the installer), and the GitHub download host it redirects to                                               |

No crash reports, usage statistics, search suggestions, Safe Browsing lookups or spell-check dictionary downloads. Portable copies make no update check.

## Updates

- Installed copies update from [GitHub Releases](https://github.com/aquabrowser/aqua/releases) with electron-updater, through its own in-memory session (no cookies, nothing of the browsing sessions). Portable copies are replaced by hand. Code: `src/main/services/updater.ts`.
- A new version downloads by itself to `%LOCALAPPDATA%\aqua-browser-updater` and installs silently when Aqua exits, or at once with Settings → About → Restart to update.
- The download is checked against the SHA-512 in the release's `latest.yml`. Releases are not code-signed yet, so the installer's publisher is not verified: an update is as trustworthy as the GitHub release it comes from.

## Known limitations

Listed in the [README](../README.md#known-limitations), with the trade-offs behind them in [architecture.md](architecture.md#design-decisions).
