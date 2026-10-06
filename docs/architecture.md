# Aqua architecture

How Aqua is put together, for contributors. The security model is summarised in [security.md](security.md).

## Source layout

```
src/
  shared/      IPC contract (ipc.ts), window.aqua API (api.ts), domain types,
               URL helpers, tracking-parameter list (tracking.ts)
  main/
    index.ts               bootstrap, pending wipe, session hardening, service wiring
    ipc.ts                 every ipcMain handler: sender check, vault gate, argument validation
    protocols.ts           aqua:// placeholder pages, aqua-ui:// production UI with strict CSP,
                           aqua-resource:// neutered stand-ins for blocked scripts
    theme.ts               native palette (window controls) for each theme preset
    browser/
      window-controller.ts one per window: tabs, layout, overlay layers, tab-modal prompts
      tab.ts               one WebContentsView per tab: lifecycle → TabState, dialogs,
                           external apps, redirect cleaning
      appearance.ts        per-tab prefers-color-scheme override (DevTools protocol)
      external.ts          which app would open discord:, steam:, tg: …; blocked schemes
      menus.ts, shortcuts.ts
    services/              vault, settings, history, bookmarks, downloads, session,
                           permissions, protocol grants, shortcuts, certificates,
                           cookie jar, site storage, content blocker
    blocker/               filter list catalog, engine configuration
    storage/               encrypted SQLite database, AES-256-GCM sealing
    workers/               Argon2id key derivation, filter list compilation
  preload/
    index.ts               browser UI bridge: frozen window.aqua, one function per channel
    tab.ts                 every frame: storage restore, element hiding, scriptlets,
                           link cleaning, page-world protections
    page-protections.ts    dialogs, clipboard and passkey guards (serialised into pages)
  renderer/    browser UI: chrome/ (tab strip, toolbar, omnibox, popups, prompts), pages/, styles/
resources/filters/  bundled filter lists and uBO's scriptlet resources (npm run fetch:filters)
resources/brand/    the logo (SVG): app icon, lock screen, About, internal page icons
```

## Process and layering model

- Every tab is a sandboxed, context-isolated `WebContentsView` owned by the main process
  (no `<webview>`). `app.enableSandbox()` applies to every renderer.
- The browser UI is the window's own webContents, in a separate cookie-less session.
- Z-order per window, bottom → top: **UI → tab views → find bar → link status →
  tab-modal prompts → popups**. Anything that must overlap a page is rendered into a
  transparent overlay document the UI opens with `window.open('about:blank')`; the main
  process wraps it in a `WebContentsView`. It shares the UI's renderer and JS realm, so
  React portals render into it directly.
- Internal pages (`aqua://newtab`, `settings`, `history`, `downloads`) load an inert
  placeholder document in the tab while the UI draws the page underneath the hidden view.

## Vault

- One SQLite file; every record is sealed with AES-256-GCM under a random data key. The
  data key is wrapped by a key derived from the master password with Argon2id (128 MiB,
  4 passes, 4 lanes, in a worker thread). Only window geometry and the theme preset are stored
  in plaintext, so the lock screen can render before unlock.
- A master password is required on every launch; there is no recovery key. Failed attempts
  back off exponentially (persisted across restarts). Aqua locks on idle, screen lock and
  suspend; locking writes what is pending and zeroes the data key, which the next unlock
  unwraps again.
- History row ids are random (128 bits): the one plaintext part of a visit says nothing about
  when it happened.
- First run takes three steps on the lock screen: what Aqua keeps and where, the master
  password, then the search engine. `onboardingCompleted` (encrypted settings) marks the last
  step. Profiles from before it count as done; a new vault whose last step was skipped by quitting
  resumes there after the next unlock. Pages stay hidden until it is done.
- Wiping ("Wipe Vault / Reset All Data") is only possible from Settings with the vault
  unlocked, never from the lock screen. The profile folder is emptied at the next launch,
  before anything opens it.

## Browsing data on disk

Info-stealers read browser profiles while the browser runs: Chromium's cookie database and
site storage are files, protected at best by a key that any program running as the user can
use. Aqua's browsing sessions have no such files.

- **Every browsing session is in memory.** Regular windows share one in-memory partition
  (`aqua-browsing`), each private window gets its own. Chromium keeps their cookies,
  localStorage, IndexedDB, cache and service workers in RAM only.
- **Cookies** are sealed into the vault like every other record, a moment after they
  change (1.5 s after a burst, at least every 10 s) and on quit, and put back into the session
  at the next unlock, before the first page loads. `HttpOnly`, `Secure`, `SameSite`,
  host-only and `__Host-` cookies are recreated exactly.
- **localStorage** of first-party frames is restored by the tab preload before any page
  script runs, and snapshots are sealed into the vault as they change (checked every 5 s,
  and when a page is hidden or closed). One row per origin; row ids are keyed hashes, so the
  database does not reveal which sites have data. Third-party frames (ads, widgets) keep
  theirs for the session only.
- **The default session** is persistent, so nothing browses in it: it refuses all web
  traffic, and a view created without an explicit session fails instead of writing cookies.
- What stays on disk in the profile folder is the vault (`aqua.db`), filter list updates
  (public data) and Chromium's own state: GPU shader caches, `Local State`, and the empty
  stores Chromium creates for the unused default session. No cookie, storage value or visited
  host. Network state that versions before in-memory browsing left there (`Network Persistent
State`, `TransportSecurity`, `DIPS`, which list visited hosts) is overwritten with random
  bytes and deleted at every start, before Chromium opens it.
- A packaged Aqua refuses to start with `--remote-debugging-port` / `-pipe` (stealers relaunch
  browsers with them to read cookies over DevTools), and its Electron fuses disable
  `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`.
- **App code integrity**: the app ships as `app.asar`, whose hash is embedded in the executable
  (fuses `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar`). A modified archive
  stops Aqua at launch, before any of its code runs, so malware can't quietly patch Aqua's
  JavaScript to capture the master password. Electron's demo app (`default_app.asar`) is removed
  from every build.

A running, unlocked Aqua still holds everything in its own memory: malware that can read
another process's memory, or inject into it, is not stopped by any of this.

## Where the profile lives

Settings → Storage shows the exact folder, whether the copy is portable, how much space the
vault, filter lists and Chromium's own files take, and opens the folder. It also warns when an
installed Aqua has left a profile in `%APPDATA%\aqua-browser` that a portable copy doesn't use.

| Mode               | Profile folder                                 | Chosen when                                          |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------- |
| Custom             | `AQUA_USER_DATA_DIR`                           | the variable is set                                  |
| Portable, one file | `AquaData` next to `Aqua-Browser-Portable.exe` | started by the portable launcher                     |
| Portable, folder   | `Aqua Browser\AquaData`                        | an `AquaData` folder sits next to `Aqua Browser.exe` |
| Installed          | `%APPDATA%\aqua-browser`                       | otherwise (and when the drive is read-only)          |

Neither portable variant writes to `%APPDATA%`: checked by launching both and comparing the
folder's newest timestamp before and after. The one-file launcher (electron-builder's NSIS
stub) unpacks the program to a fresh folder in `%TEMP%` on every launch and deletes it on exit:
program files only, never profile data. The folder build skips that step:

| Cold start to window (Windows 11) | Time                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| One-file portable                 | 10.5 s                                                             |
| Portable folder                   | 0.49 s (5.0 s on the very first launch, while Windows scans files) |

Start-up stays short because everything is bundled by Vite except `electron-updater` (installed
copies load it 15 s after start), source maps are left out, only the `en-US` Chromium locale ships, the compiled filter
engine is cached (`filters/engine.bin`, keyed by engine version, configuration and each list's
size and date; ~40 ms to load instead of ~0.6 s to compile), and the blocker starts after the
first window is on screen.

## Profiles and guest sessions

Each profile is a folder with its own vault (`aqua.db`, its own master password) and runs in a
process of its own: Electron's single-instance lock belongs to the folder, so profiles share no
memory, keys or browsing session. The default profile is the data root itself, so an existing
installation keeps its data in place.

| Path                   | What                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| `<root>`               | The default profile, and the filter lists every profile shares        |
| `<root>\profiles.json` | Names and colours (unencrypted, so the lock screen can list them)     |
| `<root>\Profiles\<id>` | Every other profile                                                   |
| `<root>\Guest`         | Chromium's own working files of the guest session, emptied each start |

`--aqua-profile=<id>` and `--aqua-guest` pick what a process runs (`lib/profiles.ts`); an unknown
id opens the default profile. Opening a profile starts that process, or brings its window forward
if it already runs. The single-file portable build starts its launcher instead of its own copy, so
the new process gets an unpacked copy of its own (`unpackDirName: false` makes each launch's copy
unique; with a fixed name, two launchers would delete each other's program files).

A guest session's vault is an SQLite database in memory, unlocked with a random key that is never
stored: it has no lock screen, nothing to lock or wipe, and history, cookies and site data vanish
with the process. Its GPU shader cache is off.

A profile that is open can't be deleted: its process writes `aqua.pid` into its folder, and the
folder is renamed before it is removed (Windows refuses to rename a folder with open files). Wiping
the default profile leaves `Profiles`, `Guest` and `profiles.json` alone. Only the default profile
installs updates.

## Appearance and the New Tab page

- **Theme presets** - Light, Classic dark, Midnight (pure black for OLED screens) and Slate
  (cool blue-greys). "Match system" pairs Light with the chosen dark preset. The tab strip,
  toolbar, omnibox, settings, popups, tab-modal dialogs and the native window controls
  (`setTitleBarOverlay`) all switch at once, without a restart.
- **New Tab page** - clock and date, an optional greeting, five clock fonts (all already on
  Windows, nothing downloaded), shortcuts as a grid or hidden, and "Suggest sites" to fill free
  tiles from history or show only the user's own. Backgrounds: the theme colour, six tones, four
  dark gradients or the user's own picture. Text and tiles follow the backdrop's brightness, not
  the window theme, so they stay readable either way.
- **Background pictures** are stored encrypted in the vault (PNG, JPEG, WebP or GIF, up to 8 MB,
  recognised by content, never SVG). One from a web address is downloaded once, through
  Chromium's network stack (system proxy included) in a throwaway in-memory session with no
  cookies; the New Tab page never contacts that server.

## Content blocking

uBlock Origin itself cannot run: Electron loads extensions only into persistent sessions
(`loadExtension` rejects in-memory ones, and in-memory sessions are off-the-record contexts for
which Electron reports every extension as not incognito-enabled - so content scripts,
`webRequest` listeners and extension resources don't reach them). Aqua uses uBO's filter lists
with the Ghostery adblocker engine instead, in every window, private ones included:

- **Lists** - uBO's defaults: uBlock filters (ads, badware, privacy, quick fixes, unbreak),
  EasyList, EasyPrivacy, Peter Lowe's list and the Online Malicious URL Blocklist; cookie-notice
  and annoyance lists are optional. They ship with Aqua and are refreshed every four days from
  uBO's mirrors (Node's `fetch`, not a browsing session); compiling them (~0.6 s) runs in a
  worker, and the result is cached until a list changes.
- **Network** - `session.webRequest` cancels matching requests. Where uBO would substitute a
  neutered resource (`redirect=` - a no-op adsbygoogle.js, a blank pixel), Aqua serves it from
  `aqua-resource://<per-run secret>/`: Chromium refuses to redirect subresources to `data:`
  URLs, and the secret host stops pages from probing for it. `$csp=` filters add a policy header.
- **Cosmetic** - the tab preload asks for a frame's element-hiding CSS and scriptlets before any
  page script runs (user-origin stylesheet; scriptlets via `executeInMainWorld`, so a page's CSP
  can't stop them), then reports ids, classes and links as they appear for generic rules.
- **Site fixes** - Aqua's own corrections for side effects the lists leave behind: on YouTube,
  the "Experiencing interruptions?" snackbar (shown although playback works) is hidden - only
  snackbars that point to YouTube's help centre, so ordinary ones stay, in any language.
- **Per site** - the toolbar shield shows the count and pauses blocking on a site (Settings →
  Privacy lists paused sites). A pause in a private window lasts until it closes.

## Privacy and security

- **Tracking parameters** (`utm_*`, `fbclid`, `gclid`, `igshid`, `mc_eid` …) are removed from
  links as they are followed (tab preload), from tracking redirects (`will-redirect`) and
  from browser-initiated loads. Only listed parameters are touched; OAuth, session and
  callback parameters are never modified. Toggle: Settings → Privacy.
- **WebRTC** uses `default_public_interface_only` on every page: calls take the default network
  route only (a VPN's, when one is on) and local network addresses are never offered to the other
  side. "Calls only through a proxy" (Settings → Privacy) switches to `disable_non_proxied_udp`,
  so nothing bypasses a proxy; without a proxy, calls then can't connect.
- **Clipboard**: reads and writes need a click or keypress, clipboard-read needs a
  per-site permission and a focused page, and a page cannot swap the text a user copies: not
  in its copy handler, and not with `writeText` or `write` straight after the copy.
- **Native-looking page surface**: what the page protections replace (dialogs, clipboard,
  WebAuthn) are proxies of the originals, and `Function.prototype.toString` reports them as native
  code. `window.chrome` has `app`, `csi` and `loadTimes`, as every Chromium build does (Electron
  leaves it empty). Scripts that look for tampered natives or an empty `window.chrome` take a
  browser for an embedded or automated one: Google's sign-in refuses those as "not secure". The
  user agent and Client Hints are Chromium's own and are not altered.
- **Screen capture**: Settings → Privacy → Hide from screen capture calls
  `setContentProtection` (`WDA_EXCLUDEFROMCAPTURE`) on every window, from launch (the setting is
  kept with the theme hint, so the lock screen is covered too).
- **Passkeys**: conditional mediation ("passkey autofill") is reported unavailable, and
  WebAuthn requests are refused until the user has interacted with the page - no account
  picker on page load.
- `alert` / `confirm` / `prompt`, permission requests and external-app launches
  (`discord:`, `steam:`, `tg:` …) use Aqua's own tab-modal prompts; a site can be allowed to
  open an app without asking. Dangerous schemes (`ms-msdt:`, `search-ms:`, `ms-appinstaller:`,
  the Office schemes that open documents straight from a server …) are never handed to the OS.
- "Leave site?" (`beforeunload`) uses Aqua's dialog when a tab or window is closed, when Aqua
  quits, and when the user navigates (address bar, back/forward, reload). "Page unresponsive"
  offers End page / Wait and is withdrawn when the page recovers.
- **Languages**: websites receive the system's preferred languages as `Accept-Language`
  (each with its base language), not just the interface's `en-US`.
- **Flood protection**: nothing a page does can pile up in the UI. Passkey dialogs
  need a fresh click, one at a time with a pause after each; a page that answers dialogs with
  more dialogs has them suppressed after five in ten seconds; external-app prompts pause after
  a Cancel and launches are spaced out; a dismissed permission request isn't asked again for
  30 seconds; at most three prompts can wait per tab.
- **Automatic downloads** follow Chromium's rules (DownloadGate): a page's first download is
  allowed, and each click or keypress in it allows one more. Anything else is held and the user
  is asked once ("Download multiple files?") - downloads arriving meanwhile wait for the same
  answer, at most ten; the rest are refused. Held downloads go to a staging folder inside the
  profile (Chromium finishes small downloads even when paused), so nothing reaches Downloads
  before "Allow"; "Block" deletes them and refuses the page's further downloads; dismissing
  refuses them for 30 seconds. Even an allowed page is asked again after ten automatic downloads
  in a minute. Saving from Aqua's own menus ("Save link as…") is never limited.
- **Permissions** (camera, microphone, location, notifications, MIDI, clipboard) are asked in a
  bubble at the address bar, remembered per site, and every request is answered - a closed tab,
  a navigation or the vault locking resolves pending ones as "not allowed", never a hang.
  **Screen sharing** opens Aqua's picker (screens and windows with previews, optional system
  audio on Windows): it needs a click in the page, is never remembered, and only a source the
  picker offered can be shared. **Pop-ups** without a click are blocked, with an address-bar
  button to open them.
- **Private windows** (Ctrl+Shift+N) each get their own in-memory partition
  (`incognito-<timestamp>`): no history, session restore, saved permissions or app grants;
  downloads are listed only in that window and forgotten when it closes; the partition's
  cookies, storage and caches are cleared on close.
- IPC: typed channel maps shared by both sides; UI channels accept only the top frame of a
  window's UI; browsing-data channels are refused while locked; every argument is
  runtime-validated.

## Design decisions

Behaviour that follows from a deliberate choice, with its side effect.

- **Closing a window** closes its pages one at a time, the active tab first, so each can run
  `beforeunload`. The window is hidden meanwhile and comes back if a page asks "Leave site?".
  Stay restores the tabs already closed (each loads when shown) and cancels a quit in progress.
  The session keeps the window as it was when the close began. A locked window, or one closed by
  Windows shutting down, closes without asking.
- **Page-initiated navigations** away from unsaved changes show Chromium's native "Leave site?"
  box: Electron needs that answer synchronously, before Aqua's own dialog could render.
- **Held downloads** are saved to the Downloads folder without the "Ask where to save" dialog, so
  a page can't open save dialogs by the dozen.
- After **Block** in the multiple-downloads question, the page can't start downloads even with a
  click until the user moves on to another site, as in Chrome.
- **Tabs closed mid-download** stay alive, hidden, until the transfer ends: Electron cancels a
  download when its page is destroyed.
- **No "Add to dictionary"**: in-memory sessions can't keep a custom dictionary, and a persistent
  one would be a plaintext file of words typed into pages.
- **Passkeys** requested on page load after a navigation must be retried with a click: WebAuthn
  waits for a user gesture in the page.
- **Cancelling the screen-sharing picker** rejects `getDisplayMedia()` with `AbortError` (Chrome
  uses `NotAllowedError`); Electron decides the error.
- **uBO's lists** turn off generic element hiding on `localhost` and `127.0.0.1`, as uBO does.
- **File pickers** follow the Windows theme, and Chromium's own strings are English only, since
  only the `en-US` locale ships.
- **Platforms**: verified on Windows 11. The macOS (traffic lights) and Linux paths are
  implemented but untested.
