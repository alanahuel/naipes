# Desktop builds and releases

## Platforms

| Platform | Build runner | Packages | In-app update |
|---|---|---|---|
| macOS, Apple Silicon | `macos-26` (arm64) | unsigned DMG + ZIP | notice only (Squirrel.Mac refuses unsigned apps) |
| Windows, x64 | `windows-2025` | unsigned per-user NSIS installer | NSIS |
| Linux, x64 | `ubuntu-24.04` | AppImage + `.deb`; AUR `naipes-bin` | AppImage replacement; `.deb` through dpkg/apt with elevation if needed; AUR: notice only (pacman updates it) |

Naipes is unsigned on every platform: there is no Apple Developer ID and no Windows certificate. On macOS, open the app the first time with right-click → Open; Squirrel.Mac only installs signed builds, so since 2026-11-06 macOS never loads `electron-updater`: it runs the same notice-only checks as a local build (Settings shows the new version with a link to its release page, plus one desktop notification per version) and the user downloads the new DMG. On Windows, SmartScreen may warn about an unknown publisher on initial installation. AppImage is the primary Linux download because it is self-contained and updates without administrator permission. The installed `electron-updater` 6.8.9 also supports `.deb` updates; an update may request an administrator password. Both use the same download/restart banner.

**Notice-only copies** (`electron/local-update-check.cjs` `noticeKind`): a local build (`npLocalBuild`), macOS, and an AUR install — the AUR package writes `pacman` to `resources/package-type`, and pacman owns those files, so the app tells the user to update with their package manager (e.g. `paru -Syu`) and shows no download link. They check at startup, every 24 h and on demand, never download or install anything.

**Version-less installer copies.** Each packaging job also uploads its installers under stable names — `Naipes-arm64.dmg`, `Naipes-x64-setup.exe`, `Naipes-x86_64.AppImage`, `Naipes-amd64.deb` — so the website links `https://github.com/alanahuel/naipes/releases/latest/download/<name>` and never needs a version bump. The update feeds never reference them.

The custom app bar stays on all three platforms. macOS keeps its left-side traffic lights; Windows/Linux use Electron's native right-side Window Controls Overlay, with CSS space reserved from the overlay's actual geometry. Windows/Linux hide the native menu until Alt is pressed. macOS keeps its system menu.

Icons are generated for every platform from one design source, `build/icon-flat.svg`, by `node scripts/make-icons.mjs`: `build/icon.icns` (macOS, 16→1024), `build/icon.ico` (Windows) and `build/icon.png` (Linux). Linux's desktop identity is `naipes.desktop`. Public package-maintainer metadata uses the owner's GitHub no-reply address; support goes through [GitHub Issues](https://github.com/alanahuel/naipes/issues).

## Build pipeline

Each OS installs its own dependencies and builds its own Next standalone tree:

1. `pnpm install --frozen-lockfile` (the repo uses pnpm with a hoisted, npm-shaped `node_modules` and no dependency install scripts — see `pnpm-workspace.yaml`)
2. Native PDF/SVG renderer tests for that OS, running in Electron's bundled Node (no display needed).
3. `pnpm run build` (`output: "standalone"`).
4. `node scripts/build-server.mjs` — copy static assets, refuse leaked data/keys, remove only standalone-root `dist/` and `node_modules/electron/` (old installers and the development runtime), check prompt assets. Runtime dependencies' own `dist/` directories and native renderer binaries stay intact.
5. `node scripts/smoke-server.mjs --electron` — boot the standalone server in Electron's bundled Node, using empty temporary data/auth, then check the home route and GET-only APIs.
6. `pnpm exec electron-builder <platform flags> --publish <policy>`.

The shell/updater live in `app.asar`; the standalone server and native renderer binaries ship unpacked as `extraResources`. **Do not cross-build the server payload.** Next traces the build machine's native binaries, so a macOS-built standalone tree is not a Windows/Linux payload.

`pnpm run desktop:dist` builds an unsigned macOS arm64 package locally. For a local Windows/Linux build, run steps 1–5 above, then:

```sh
# On Windows:
pnpm exec electron-builder --win --x64 --publish never

# On Linux:
pnpm exec electron-builder --linux --x64 --publish never
```

For a personal Linux install of this checkout (AppImage, launcher, icon; auto-update off, new-release notices on), use `bash scripts/install-linux.sh` — see [obsidian.md](obsidian.md).

## CI vs release

`.github/workflows/ci.yml` runs on main pushes and pull requests:

- Typecheck, full deterministic test suite, and lint on Ubuntu.
- Native renderer tests plus standalone build/boot-smoke on macOS (`macos-15`), Windows, and Linux. This macOS job does not compile the Icon Composer asset; only release packaging needs the newer runner.

`.github/workflows/release.yml` has two deliberately separate modes:

- **Manual / Run workflow:** unsigned rehearsal installers saved as workflow artifacts for 7 days. No signing secrets needed, no release created, and nothing published. Use the artifacts for a human smoke pass before tagging.
- **Push `v<package.json version>`:** gates first, then one job creates or reuses a **single draft GitHub Release** before the three OS jobs package/upload their artifacts and update metadata in parallel. This avoids competing draft creation. A published or ambiguous existing release fails the preparation step instead of being modified. Separate runs for the same ref are serialized, never cancelled mid-upload. The tag must match the package version. The workflow never publishes the draft. After all three packaging jobs succeed, a final read-only **Verify draft release** job (below) fails the run unless that draft is complete and self-consistent.

The three jobs upload distinct updater feeds: `latest-mac.yml`, `latest.yml`, `latest-linux.yml`, with the matching ZIP/NSIS/AppImage/deb assets and blockmaps. **A partially populated draft is never fit to publish — and the final job enforces it mechanically.** The app uses the baked GitHub feed without a token: **the repository must be public before end users can download updates.** Making the repository public and publishing the release remain the owner's actions.

### The verification job

`verify` runs only on tag pushes (`needs: package`, so after **all three** packaging legs; manual rehearsals upload nothing and skip it). It checks out the tagged revision without persisting credentials and runs `scripts/verify-release.ts`. GitHub requires push access to list **draft** releases, so this job needs `contents: write` even though every API operation is GET-only. The token is exposed only to the release-list and feed-download steps, not dependency installation or the offline validator. The validator:

- finds the draft using the same tag matching as the draft job and electron-builder's publisher — `tag_name` equals `v<version>` **or** the bare `<version>`; zero matches, two matches, or an already-published match fail the run, and a draft matched only via the unprefixed form is flagged with a warning (a later run could create a second draft under the `v`-tag and split the assets — rename before publishing);
- fails unless the release holds **exactly** these 15 assets — nothing missing, nothing extra (a stale name from an older run is an error), nothing zero-size, nothing still in a non-`uploaded` state:

| Asset | Role |
|---|---|
| `Naipes-<v>-arm64.dmg` + `.blockmap` | macOS installer |
| `Naipes-<v>-arm64-mac.zip` + `.blockmap` | macOS updater payload (Squirrel.Mac installs from the ZIP) |
| `Naipes-<v>-x64-setup.exe` + `.blockmap` | Windows NSIS installer |
| `Naipes-<v>-x86_64.AppImage` | Linux AppImage (no sidecar blockmap) |
| `Naipes-<v>-amd64.deb` | Linux deb (no sidecar blockmap) |
| `latest-mac.yml` / `latest.yml` / `latest-linux.yml` | updater feeds |
| `Naipes-arm64.dmg`, `Naipes-x64-setup.exe`, `Naipes-x86_64.AppImage`, `Naipes-amd64.deb` | version-less copies for `releases/latest/download/` links — each must match its versioned original's size |

  (The Linux names are deliberate: the user-set `linux.artifactName` applies to both Linux targets, and `${arch}` expands per target — `x86_64` inside the AppImage, `amd64` in the deb — exactly what the installed app-builder-lib 26.15.3 emits. The script's expectations fail closed if `electron-builder.yml` drifts from these shapes.);
- downloads the three feeds from the draft and fails unless each parses, carries the `package.json` version, and references **exactly** the uploaded assets — by bare file name only (no paths, traversal, or URLs), with sizes matching the API-reported asset sizes, the ZIP first in `latest-mac.yml`, and the legacy top-level `path`/`sha512` backed by that first entry.

The job only reads (release list + asset downloads); it never creates, edits, publishes, or deletes anything.

## CI secrets

GitHub's built-in `GITHUB_TOKEN` supplies `GH_TOKEN` with job-scoped `contents: write`; no signing credentials exist. The only stored secret is `AUR_SSH_PRIVATE_KEY` (below). Never commit certificates, passwords, keys, or `.env.local`.

## AUR (`naipes-bin`)

`packaging/aur/PKGBUILD` repackages the release `.deb` into `/opt/Naipes` (plus `/usr/bin/naipes`, the launcher and the icon) and writes `pacman` to `resources/package-type`. `.github/workflows/aur.yml` runs when a release is **published** (drafts' assets aren't public; prereleases are skipped): in an `archlinux:base-devel` container, `packaging/aur/update.sh <version>` pins `pkgver`, resets `pkgrel` and the `.deb`'s sha256, regenerates `.SRCINFO`, and the job pushes both to `ssh://aur@aur.archlinux.org/naipes-bin.git` with the `AUR_SSH_PRIVATE_KEY` secret — a key used only for this, whose public half is on the owner's AUR account. The AUR host key is pinned in the workflow. A manual run (`gh workflow run aur.yml -f version=X.Y.Z`) republishes a version; it does nothing when the AUR already matches.

Local test: `bash packaging/aur/update.sh <version> && cd packaging/aur && makepkg -si`.

## First release runbook

1. Push the implementation; run the manual Desktop release workflow.
2. Human smoke on Windows/Linux: install/open, window buttons and dragging, sidebar at narrow widths, zoom, setup/keys, session/resume, native PDF/SVG verification and demo helper.
3. Bump `package.json` and the lockfile to the agreed release version; run local gates and push a matching `v...` tag.
4. Wait for **all three** packaging jobs **and the final Verify draft release job** — the gate mechanically checks the draft's 15 assets and the three update feeds (single draft, right names/version/sizes/upload state, feeds referencing only what the release actually holds). If it fails, fix the cause and re-run the workflow before publishing; electron-builder replaces same-named assets on re-upload, and the gate rejects leftovers.
5. Owner publishes the complete draft, then checks the real GitHub update path using a prior installed version. Publishing triggers the AUR workflow; check that `naipes-bin` moved to the new version.

A full human pass is required before the first three-platform release. Subsequent content-only updates rely on the deterministic suite plus the per-OS build/boot-smoke matrix. Changes to `electron/`, native modules, packaging/updater configuration, or Electron itself call for another platform smoke pass.
