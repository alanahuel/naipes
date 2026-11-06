/**
 * Naipes — the Electron shell (wrapper milestone, 2026-09-17).
 *
 * What this process is and is not:
 *   IS:  a thin launcher + security guard around the app's real server —
 *        `next build`'s standalone server.js (Next 16), spawned as a child
 *        on 127.0.0.1 with the BYOK auth file and the NP_DATA_DIR seam.
 *   NOT: a host for any app logic. Everything — teacher turns, extraction,
 *        the graph — runs in the Next server, unchanged.
 *
 * Pattern (fact-checked 2026-09-17 against current Electron 44 / Next 16
 * docs — see .memory release-strategy + electron-wrapper notes):
 *   - spawn via process.execPath + ELECTRON_RUN_AS_NODE=1 (Electron's
 *     bundled Node 24; the runAsNode fuse must stay enabled);
 *   - the server dir ships UNPACKED via extraResources (asar archives are
 *     read-only and native .node/dylib can't dlopen from one);
 *   - all mutable state under userData (never inside the .app bundle —
 *     translocated apps are read-only);
 *   - keys ride the child's ENV, never argv; auth.json (BYOK) is a flat
 *     {VAR: value} JSON map, plaintext, mode 0600 — server-managed since
 *     the auth-keys wave (2026-09-19): the child reads/writes it DIRECTLY
 *     (NP_AUTH_FILE below) and reflects values into its own env. The old
 *     spawn-time env injection retired with that wave — a copy made here
 *     would shadow every settings-page key change until restart.
 */

const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, nativeTheme, session, shell } = require("electron");
const { createChatGPT, fileStore } = require("./chatgpt.cjs");
const { attachChatGPTChild, trustedSender, chatGPTControl } = require("./chatgpt-ipc.cjs");
const { createSubscriptions, loadSubscriptionSDK } = require("./subscriptions.cjs");
const { attachSubscriptionChild, subscriptionControl } = require("./subscription-ipc.cjs");
const { desktopAPIHeaders, HEADER: DESKTOP_API_HEADER } = require("./desktop-api.cjs");
const reviewDesktop = require("./review-desktop.cjs");
const { openWebSubscriptionBrowser } = require("./web-subscription-browser.cjs");
const localUpdates = require("./local-update-check.cjs");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { knowledgeSourcePath } = require("./knowledge-source.cjs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

// Mirrors SIDEBAR_AUTOCLOSE in components/sidebar.tsx — keep in sync (the
// renderer owns the number; this is the IPC widen target).
const SIDEBAR_AUTOCLOSE = 928;

const PRODUCT_NAME = "Naipes";

/** Native chrome per theme (mirrors --frame + a readable symbol color in
 *  app/globals.css). The renderer reports its effective theme over
 *  "np:set-theme"; until then the OS preference decides. */
const THEME_CHROME = {
	light: { background: "#f4f4f4", symbol: "#3f3f3f" },
	dark: { background: "#0f0f0f", symbol: "#d6d6d6" },
};
const initialChrome = () => THEME_CHROME[nativeTheme?.shouldUseDarkColors ? "dark" : "light"];

// APP NAME → userData (owner, 2026-10-10): the Application Support dir is
// exactly "Naipes" in dev AND packaged. Packaged Electron would
// otherwise derive it from package.json "name" (now lowercase
// "naipes"), and productName metadata alone doesn't reach app.name.
// Must run before the NP_DEV_URL suffix below — dev becomes
// "Naipes-dev".
app.setName(PRODUCT_NAME);

/** RENAME MIGRATION (LearnHarness → Naipes, 2026-11-03): the userData dir
 *  follows the app name, so a first Naipes launch would start empty. When
 *  the new dir holds no data/keys yet and the sibling legacy dir exists
 *  (same "-dev" suffix in dev), COPY it over — the legacy dir stays as a
 *  backup. Runs after the single-instance lock so two launches never copy
 *  at once; Chromium's per-instance Singleton* files are skipped. */
function migrateLegacyUserData() {
	const target = app.getPath("userData");
	const legacy = path.join(path.dirname(target), path.basename(target).replace(PRODUCT_NAME, "LearnHarness"));
	try {
		if (legacy === target || !fs.existsSync(legacy)) return;
		if (fs.existsSync(path.join(target, "data")) || fs.existsSync(path.join(target, "auth.json"))) return;
		fs.cpSync(legacy, target, {
			recursive: true,
			force: false,
			errorOnExist: false,
			filter: (src) => !path.basename(src).startsWith("Singleton"),
		});
		console.log(`[np] migrated user data from ${legacy}`);
	} catch (err) {
		console.error("[np] user data migration failed:", err);
	}
}

const AUTH_FILE = () => path.join(app.getPath("userData"), "auth.json");
const DATA_DIR = () => path.join(app.getPath("userData"), "data");

/** The packaged standalone server (extraResources → Resources/server).
 *  In dev NP_DEV_URL short-circuits everything: no spawn, no packaging —
 *  the window points at the running `next dev` server (full HMR). */
function serverEntry() {
	// extraResources ships the whole .next payload under server/standalone/
	// (copied from .next with an explicit filter — see electron-builder.yml).
	return path.join(process.resourcesPath, "server", "standalone", "server.js");
}

// ─── Single instance: two instances would fight over the data dir ─────────
// ─── Browser-service helper (Wave E stage 3, owner 2026-10-10) ────────
// The render engines for agent jobs: PDFs and SVGs rasterize natively
// (pdfjs+Skia, resvg — no browser); DEMOS execute JS and need one. The
// app's own Chromium serves that via this helper — the server spawns
//   <this binary> --browser-service
// and connects over CDP (system Chrome stays the fallback). Handshake:
// the helper prints "BROWSER_SERVICE_CDP <port>" on stdout once the CDP
// endpoint listens. Lifetime: parent IPC disconnect/death = quit.
// MUST run before the single-instance lock — a helper is a second
// instance of this very binary, and before the NP_DEV_URL redirect — the
// helper owns no user data at all.
if (process.argv.includes("--browser-service")) {
	const { waitForBrowserService } = require("./browser-service-readiness.cjs");
	// Own the helper's entire startup lifetime, including the readiness wait.
	const lifetime = new AbortController();
	const parentClosed = () => {
		lifetime.abort(new Error("browser-service parent IPC disconnected"));
		app.quit();
	};
	(async () => {
		try {
			// Full Windows Electron replaces stdin with synthetic EOF. Use the
			// real Node IPC channel, and refuse to start an unowned helper.
			if (!process.channel || !process.connected) throw new Error("browser-service requires connected parent IPC");
			process.once("disconnect", parentClosed);
			app.dock?.hide();
			const port = await freePort();
			// Must land before app-ready for Chromium to pick it up.
			app.commandLine.appendSwitch("remote-debugging-port", String(port));
			await app.whenReady();
			// A hidden window keeps the app lifecycle ordinary on every
			// platform (no window-all-closed handler is installed here).
			const win = new BrowserWindow({ show: false });
			await win.loadURL("about:blank");
			// Window load is not a DevTools HTTP readiness barrier. Confirm the
			// endpoint before both production and smoke clients see the handshake.
			await waitForBrowserService(port, { signal: lifetime.signal });
			if (!lifetime.signal.aborted) console.log(`BROWSER_SERVICE_CDP ${port}`);
		} catch (err) {
			if (lifetime.signal.aborted) return; // Parent disconnect is normal.
			console.error("browser-service failed:", err);
			app.exit(1);
		}
	})();
} else {
	// Dev shell (NP_DEV_URL) runs BESIDE the packaged app, not instead of it:
	// its own userData so (a) the single-instance lock — checked below — doesn't
	// silently kill it, and (b) it never reads/writes the real app's
	// localStorage, auth.json, or logs. Must run before the lock check.
	if (process.env.NP_DEV_URL) {
		app.setPath("userData", `${app.getPath("userData")}-dev`);
	}

	// The whole normal boot — lock included — lives in this else: a helper is
	// a SECOND instance of this very binary on purpose (the running app owns
	// the lock), so it must never reach this check.
	if (!app.requestSingleInstanceLock()) {
		app.quit();
	} else {
		migrateLegacyUserData();
		app.on("second-instance", () => {
			// With the window closed to the tray, a second launch reopens it.
			showWindow();
		});
		main();
	}
}

let serverProcess = null;
let chatgpt = null;
let chatgptChild = null;
let subscriptions = null;
let subscriptionChild = null;
// Per-launch request capability, never OAuth tokens and never renderer state.
let desktopAPISecret = null;
let reopenWindow = null;
const trustedAppWindows = new Set();

// A GUI shell must never die to a stray exception (EPIPE dialogs, a race
// in an event handler): the window + child server are the product, and
// anything main-side is recoverable by logging it. Log-and-continue.
process.on("uncaughtException", (err) => {
	try {
		log(`uncaught: ${err?.stack ?? err}`);
	} catch {
		/* nothing left to write to */
	}
});

/** A free TCP port (listen(0) → the kernel assigns one). The close→spawn
 *  race is theoretical; localhost ports are rarely contended, and a failed
 *  spawn surfaces in the health check with the child's stderr in the log. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** BYOK keys: auth.json in userData, flat {VAR: value} map, 0600 —
 *  SERVER-MANAGED since the auth-keys wave (2026-09-19). This shell no
 *  longer reads or injects it: the child gets NP_AUTH_FILE below and does
 *  its own read/reflect/write, so a key saved in the settings page takes
 *  effect on the next model call — no restart. Real environment variables
 *  still win over the file inside the child (its documented rule). */

function log(line) {
	const stamp = new Date().toISOString();
	// The stdout write is guarded (EPIPE hardening, 2026-10-10): a packaged
	// app launched with a consumer-owned pipe (a launcher that exits, a
	// piped run) must not die on its next log line when the pipe breaks.
	// The file below stays the durable channel.
	try {
		console.log(`[np ${stamp}] ${line}`);
	} catch {
		/* stdout gone — userData/logs/main.log still carries it */
	}
	// Belt and braces: also append to userData/logs so a misbehaving child
	// can be diagnosed after the window is gone. Best effort only.
	try {
		const dir = path.join(app.getPath("userData"), "logs");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "main.log"), `[${stamp}] ${line}\n`);
	} catch {
		/* best effort */
	}
}

function startServer(port) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			// Only the macOS backend needs this: Next's native title setter
			// otherwise checks this Node-mode process in as a foreground app.
			process.platform === "darwin"
				? ["--require", path.join(process.resourcesPath, "server-title-guard.cjs"), serverEntry()]
				: [serverEntry()],
			{
				cwd: path.dirname(serverEntry()),
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: "1",
					NODE_ENV: "production",
					PORT: String(port),
					HOSTNAME: "127.0.0.1", // the server defaults to 0.0.0.0 — never
					NP_DATA_DIR: DATA_DIR(),
					// The auth/keys store — the child reads AND writes this file itself
					// (no env injection anymore: a spawn-time copy would shadow every
					// settings-page key change until restart; env wins over file).
					NP_AUTH_FILE: AUTH_FILE(),
					NP_DESKTOP_SERVER: "1",
					NP_DESKTOP_API_SECRET: desktopAPISecret,
				},
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		serverProcess = child;
		chatgptChild = attachChatGPTChild(child, chatgpt);
		subscriptionChild = attachSubscriptionChild(child, subscriptions);
		const fwd = (buf) => buf.toString().trimEnd().split("\n").forEach((l) => l && log(`server: ${l}`));
		child.stdout.on("data", fwd);
		child.stderr.on("data", fwd);
		child.on("exit", (code, signal) => {
			log(`server exited (code=${code} signal=${signal})`);
			serverProcess = null;
			chatgptChild?.dispose();
			chatgptChild = null;
			subscriptionChild?.dispose();
			subscriptionChild = null;
			chatgpt?.close();
			subscriptions?.close();
		});
		resolve(child);
	});
}

/** No "ready" event exists — poll until the server answers (docs-confirmed). */
function waitUntilUp(url, tries = 150) {
	return new Promise((resolve, reject) => {
		const attempt = (n) => {
			const req = http.get(url, (res) => {
				res.resume();
				resolve(res.statusCode !== undefined);
			});
			req.on("error", () => {
				if (n <= 0) reject(new Error(`server never answered on ${url}`));
				else setTimeout(() => attempt(n - 1), 200);
			});
		};
		attempt(tries);
	});
}

function killServer() {
	chatgpt?.close();
	subscriptions?.close();
	if (!serverProcess) return;
	const child = serverProcess;
	serverProcess = null;
	child.kill("SIGTERM");
	setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}, 3000);
}

/** Security posture (all defaults asserted explicitly; the guards are the
 *  checklist's own recommendations for localhost-app shells):
 *  - deny-by-default permission handler allowing only our loopback origin
 *    (groundwork for the mic/STT milestone — Electron auto-approves by
 *    default, we do not);
 *  - will-navigate pinned to the app origin; window.open always denied —
 *    external links go to the real browser via shell.openExternal. */
function createWindow(url) {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		title: PRODUCT_NAME,
		// Merged chrome (owner, 2026-09-17): the system title bar is gone;
		// the app's own 60px header bands ARE the title bar. The traffic
		// lights float over the sidebar's LH wordmark band, vertically
		// Aligned to the PHASE PILL's drawn box, not the band's geometric
		// center (owner ask, 2026-09-17): macOS centers each 12px circle at
		// y+6.75, and the pill box center measures 29.25 in the running app
		// (band 0–59.5, pill box 19–39.5) — y 22.5 lands the circles at
		// 29.25, exactly on the pill. Wordmark gutter: components/sidebar.tsx.
		// Dragging comes from the renderer's .np-drag bands (app/globals.css).
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 22.5 } }
			: {
				titleBarStyle: "hidden",
				// Native min/max/close on the right, at the OS's compact default
				// height. Do not force the zoom-invariant native overlay to match
				// the renderer's 60 CSS px bar: zooming out would cover its border.
				// The renderer reserves the actual width via env(titlebar-area-*).
				titleBarOverlay: { color: initialChrome().background, symbolColor: initialChrome().symbol },
				// Keep the custom bar alone; Alt reveals the native menu.
				autoHideMenuBar: true,
			}),
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			...(process.env.NP_DEV_URL ? { additionalArguments: ["--np-web-subscriptions"] } : {}),
			preload: path.join(__dirname, "preload.cjs"),
		},
		// Live-resize + first-paint flash (owner, 2026-09-17): during a resize
		// the native window surface changes size before Chromium's compositor
		// has a frame at the new size, and the gap shows the window's NATIVE
		// background — Electron's default is white, glaring on a dark app.
		// The theme's frame color fills the lag instead. `show: false` +
		// ready-to-show is the same treatment for first paint: the window
		// appears only once the page has actually rendered.
		backgroundColor: initialChrome().background,
		show: false,
		// Narrow-window behavior (owner, 2026-09-17): 640px is the floor —
		// below it even a wrapped chrome row gets cramped and the chat header
		// (lights gutter 92 + toggle + title) runs out of room. The sidebar
		// auto-closes below 928 = 640 + 288 (sidebar) in the renderer
		// (components/sidebar.tsx, SIDEBAR_AUTOCLOSE); its "np:expand-window"
		// IPC widens the window back to that threshold.
		minWidth: 640,
		minHeight: 600,
	});

	trustedAppWindows.add(win);
	win.once("closed", () => trustedAppWindows.delete(win));
	const allowedOrigin = () => new URL(url).origin;
	// Deny-by-default; the ONLY grants are media (mic/STT groundwork) and
	// clipboard-sanitized-write — the copy affordances in the transcript
	// (md-blocks copy corners) call navigator.clipboard.writeText(), which
	// Chromium only honors with that permission (chrome-melt tweaks wave,
	// 2026-09-19; before this grant every copy silently rejected). Still
	// loopback-origin only — Electron's default is auto-approve-everything,
	// and we do not ship that.
	// "local-fonts": the appearance section's reading-font picker (2026-09-26).
	const allowedPermissions = new Set(["media", "clipboard-sanitized-write", "local-fonts"]);
	const fromOwnOrigin = (origin, permission) =>
		origin === allowedOrigin() && allowedPermissions.has(permission);
	session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
		const requestOrigin = details.requestingUrl ? new URL(details.requestingUrl).origin : null;
		callback(fromOwnOrigin(requestOrigin, permission));
	});
	session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
		return fromOwnOrigin(origin, permission);
	});

	win.webContents.on("will-navigate", (event, target) => {
		if (new URL(target).origin !== allowedOrigin()) {
			event.preventDefault();
			void shell.openExternal(target);
		}
	});
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		void shell.openExternal(target);
		return { action: "deny" };
	});

	void win.loadURL(url);
	// Zoom truth reaches the renderer for EVERY load (reload, nav): the
	// renderer's --np-zoom must never go stale. The fallback catcher below
	// covers ⌘= / layout variants the menu's ⌘Plus may not claim — menu-
	// claimed keys never reach before-input-event, so exactly one of the
	// two applies any given zoom keypress.
	win.webContents.on("did-finish-load", () => {
		win.webContents.send("np:zoom", win.webContents.getZoomFactor());
	});
	win.webContents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown" || !(input.meta || input.control)) return;
		if (input.key === "=" || input.key === "+") zoomStep(win, +1);
		else if (input.key === "-") zoomStep(win, -1);
		else if (input.key === "0") applyZoom(win, 1);
		else return;
		event.preventDefault();
	});

	win.once("ready-to-show", () => win.show());
	return win;
}

/* ── Zoom (owner round 7, 2026-10-05): ⌘±/⌘0 as an OWNED ladder ──────────
 * The stock zoomIn/zoomOut roles change zoomLevel silently — the renderer
 * never learns the factor, and the native traffic lights (physical-fixed,
 * hiddenInset) drift out of relation to the scaled chrome: the graph
 * button rides away from them zoomed in, content slides under them
 * zoomed out. Here zoom is explicit: a factor ladder, applied through
 * setZoomFactor, and broadcast to the renderer ("np:zoom" — it publishes
 * --np-zoom so gutter lengths can divide by it and stay PHYSICAL-
 * constant). The traffic lights themselves stay at their construction
 * position ({x:16, y:22.5} — Electron 44 has NO runtime setter, only
 * the BrowserWindow option), which is HIG-correct anyway: native lights
 * hug the window corner while the web chrome compensates around them.
 * Vertical note: at large factors the taller bands' content centers
 * drift below the fixed lights — accepted (the alternative, moving the
 * lights, is impossible without rebuilding the window). */
const ZOOM_LADDER = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/* ── Auto-update (Wave C, owner 2026-10-10: silent download + restart ─────
 * banner; checks at startup + every 24h) ─────────────────────────────────
 *
 * Feed: GitHub Releases (electron-builder.yml publish → app-update.yml,
 * baked into the bundle). macOS updates ride the zip target (Squirrel.Mac),
 * which only installs SIGNED apps — Naipes ships unsigned, so on macOS the
 * check can find an update but installing it fails (download manually); blockmaps
 * give differential downloads for free. Windows uses NSIS; Linux uses
 * AppImage or DebUpdater (6.8.9 supports deb; installation can request
 * administrator permission via the package manager — owner 2026-10-11).
 *
 * Hard rules:
 *  - DEV NEVER UPDATES: !app.isPackaged skips the updater entirely — the
 *    dev world runs `next dev` and has no signed bundle.
 *  - THE UPDATER CAN NEVER TAKE THE APP DOWN: every event and check is
 *    caught and logged (feed down, disk full, bad signature — all just
 *    log lines; the app keeps working, update or no update).
 *  - NP_UPDATE_FEED (env): overrides the baked GitHub feed with a generic
 *    local server — the pre-release verification drill (serve
 *    latest-mac.yml + zip + blockmap from any localhost HTTP dir and
 *    watch a real installed copy find/download/restart). Test-only seam.
 *
 * Install path: the downloaded update applies on quit (autoInstallOnAppQuit
 * — Squirrel.Mac stages natively and swaps on relaunch). The renderer
 * banner asks for an immediate restart via "np:update-install"; we kill
 * the child server FIRST — deterministic ordering: the server lives
 * inside the .app bundle Squirrel is about to replace (extraResources),
 * and before-quit alone would race the swap. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let autoUpdater = null; // electron-updater's, packaged builds only
// Observational only: this snapshot NEVER gates a check, download or install.
// The revision lets late subscribers reject an older in-flight IPC snapshot.
// `local` marks a local build (notice-only checks, see setupLocalUpdateCheck);
// `url` is the release page of an "available" version (local builds only).
let updateState = { status: "idle", version: null, url: null, local: false, revision: 0 };

function reportUpdateStatus(status, version = null, url = null) {
	try {
		// A later check/error must not hide an update already staged for quit.
		if (updateState.status === "downloaded" && status !== "downloaded") return;
		updateState = {
			status,
			version: typeof version === "string" ? version : null,
			url: typeof url === "string" ? url : null,
			local: localUpdateCheck !== null,
			revision: updateState.revision + 1,
		};
		for (const win of BrowserWindow.getAllWindows()) {
			try {
				win.webContents.send("np:update-status", updateState);
			} catch {
				/* window mid-teardown — snapshot retrieval covers a later load */
			}
		}
	} catch {
		/* Status reporting must never interrupt the updater. */
	}
}

/** Read the SAME data directory passed to the packaged server. Only an
 * explicit false opts out; absent/corrupt/unreadable settings keep updates ON.
 * Re-read for each automatic check so saving the toggle needs no restart. */
function automaticUpdatesEnabled() {
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR(), "settings.json"), "utf8"));
		return settings?.general?.autoUpdate !== false;
	} catch {
		return true;
	}
}

/** The interface language for main-process text (desktop notifications):
 *  settings general.language, Spanish when absent/unreadable. */
function interfaceLanguage() {
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR(), "settings.json"), "utf8"));
		return settings?.general?.language === "en" ? "en" : "es";
	} catch {
		return "es";
	}
}

function checkForUpdates({ manual = false } = {}) {
	if (!autoUpdater && !localUpdateCheck) return;
	if (!manual && !automaticUpdatesEnabled()) {
		log("auto-update: automatic check skipped (turned off in Settings)");
		return;
	}
	if (localUpdateCheck) {
		void checkLocalBuildForUpdates();
		return;
	}
	// Do not gate on display state: a stale spinner/error must never disable
	// future background checks. electron-updater owns its in-flight work.
	autoUpdater
		.checkForUpdates()
		.then((result) => {
			// A declined check (e.g. an unsupported package) establishes no
			// latest-version claim. Real results arrive through updater events.
			if (!result) reportUpdateStatus("idle");
		})
		.catch((err) => {
			log(`update check failed: ${err?.message ?? err}`);
			reportUpdateStatus("error");
		});
}

function installUpdateNow() {
	// Kill the server BEFORE the quit-and-install (see block comment).
	try {
		killServer();
	} catch {
		/* already dead */
	}
	autoUpdater?.quitAndInstall();
}

/** LOCAL BUILD (owner, 2026-11-01): scripts/install-linux.sh bakes
 *  `npLocalBuild: true` into the packaged package.json (electron-builder
 *  extraMetadata). A locally built copy carries the owner's own changes, so
 *  the GitHub feed must never replace it: electron-updater stays off.
 *  Since 2026-11-04 (Repaso plan, stage 0b) it still ASKS GitHub whether a
 *  newer release exists and says so — see electron/local-update-check.cjs. */
function isLocalBuild() {
	try {
		return require("../package.json").npLocalBuild === true;
	} catch {
		return false;
	}
}

/* ── Local-build update notices (owner, 2026-11-04) ───────────────────────
 * Same cadence and toggle as the real updater (startup + 24h + manual,
 * Settings → automatic updates). A newer published release becomes status
 * "available" (+ its release page url) for Settings and the bell, and ONE
 * desktop notification per version (the last announced version persists in
 * userData/local-update.json). Never downloads or installs anything; every
 * failure is a log line + generic "error". */
let localUpdateCheck = null; // { repo, current } on local builds only
let localCheckInFlight = false;
const LOCAL_UPDATE_FILE = () => path.join(app.getPath("userData"), "local-update.json");

function setupLocalUpdateCheck() {
	let pkg = {};
	try {
		pkg = require("../package.json");
	} catch {
		/* handled below: no repo → disabled */
	}
	const repo = localUpdates.githubRepoFromHomepage(pkg.homepage);
	if (!repo || typeof pkg.version !== "string") {
		log("auto-update: local build without a GitHub homepage/version — update notices disabled");
		reportUpdateStatus("disabled");
		return;
	}
	localUpdateCheck = { repo, current: pkg.version };
	log(`auto-update: local build — notice-only checks against ${repo} (running ${pkg.version})`);
	reportUpdateStatus("idle");
}

function lastAnnouncedVersion() {
	try {
		const saved = JSON.parse(fs.readFileSync(LOCAL_UPDATE_FILE(), "utf8"));
		return typeof saved?.announcedVersion === "string" ? saved.announcedVersion : null;
	} catch {
		return null;
	}
}

function announceLocalUpdate(version, url) {
	if (!localUpdates.shouldAnnounce(version, lastAnnouncedVersion())) return;
	try {
		fs.writeFileSync(LOCAL_UPDATE_FILE(), JSON.stringify({ announcedVersion: version }));
	} catch (err) {
		// Unwritable: announce anyway; worst case it repeats on a later check.
		log(`local update: could not record the announcement (${err?.message ?? err})`);
	}
	try {
		if (!Notification?.isSupported?.()) return;
		const { title, body } = localUpdates.announcementText(version, interfaceLanguage());
		const notice = new Notification({ title, body });
		notice.on("click", () => void shell.openExternal(url));
		notice.show();
		log(`local update: announced ${version}`);
	} catch (err) {
		log(`local update: desktop notification failed (${err?.message ?? err})`);
	}
}

async function checkLocalBuildForUpdates() {
	if (!localUpdateCheck || localCheckInFlight) return;
	localCheckInFlight = true;
	reportUpdateStatus("checking");
	try {
		const latest = await localUpdates.fetchLatestRelease({ repo: localUpdateCheck.repo, fetchImpl: fetch });
		if (localUpdates.isNewer(latest.version, localUpdateCheck.current)) {
			reportUpdateStatus("available", latest.version, latest.url);
			announceLocalUpdate(latest.version, latest.url);
		} else {
			reportUpdateStatus("up-to-date");
		}
	} catch (err) {
		log(`local update check failed: ${err?.message ?? err}`);
		reportUpdateStatus("error");
	} finally {
		localCheckInFlight = false;
	}
}

function setupAutoUpdater() {
	if (isLocalBuild()) {
		log("auto-update: local build — electron-updater disabled");
		setupLocalUpdateCheck();
		return;
	}
	if (!app.isPackaged) {
		log("auto-update: dev build — updater disabled");
		reportUpdateStatus("disabled");
		return;
	}
	try {
		autoUpdater = require("electron-updater").autoUpdater;
	} catch (err) {
		log(`auto-update: electron-updater unavailable (${err?.message ?? err}) — updates disabled`);
		reportUpdateStatus("disabled");
		return;
	}
	const feed = process.env.NP_UPDATE_FEED;
	if (feed) {
		autoUpdater.setFeedURL({ provider: "generic", url: feed });
		log(`auto-update: NP_UPDATE_FEED override → ${feed}`);
	}
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;
	// Route every updater log line through the shell's own log (userData/
	// logs/main.log) — feed failures must be diagnosable after the fact.
	autoUpdater.logger = {
		info: (m) => log(`updater: ${m}`),
		warn: (m) => log(`updater warn: ${m}`),
		debug: (m) => {}, // too chatty for the persistent log
		error: (m) => log(`updater error: ${m}`),
	};
	autoUpdater.on("checking-for-update", () => reportUpdateStatus("checking"));
	autoUpdater.on("update-available", (info) => reportUpdateStatus("downloading", info?.version));
	autoUpdater.on("update-not-available", () => reportUpdateStatus("up-to-date"));
	autoUpdater.on("update-downloaded", (info) => {
		log(`update downloaded: ${info?.version} — banner shown`);
		reportUpdateStatus("downloaded", info?.version);
	});
	autoUpdater.on("error", (err) => {
		log(`updater error: ${err?.message ?? err}`);
		reportUpdateStatus("error");
	});
}

/** One result surface for manual checks. Preload buffers the navigation
 * request until React subscribes, including when all macOS windows closed. */
function checkForUpdatesFromMenu() {
	try {
		const win = BrowserWindow.getAllWindows()[0] ?? reopenWindow?.();
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
			const openSettings = () => {
				try { win.webContents.send("np:open-settings", "general"); } catch { /* window closed */ }
			};
			if (win.webContents.isLoadingMainFrame()) win.webContents.once("did-finish-load", openSettings);
			else openSettings();
		}
	} catch {
		/* Navigation failure must not prevent the manual check. */
	}
	checkForUpdates({ manual: true });
}

function zoomStep(win, dir) {
	const current = win.webContents.getZoomFactor();
	const next =
		dir > 0
			? ZOOM_LADDER.find((f) => f > current + 0.001) ?? ZOOM_LADDER[ZOOM_LADDER.length - 1]
			: [...ZOOM_LADDER].reverse().find((f) => f < current - 0.001) ?? ZOOM_LADDER[0];
	applyZoom(win, next);
}

function applyZoom(win, factor) {
	factor = Math.min(2, Math.max(0.75, factor)); // ladder clamps; ⌘0 = 1
	win.webContents.setZoomFactor(factor);
	win.webContents.send("np:zoom", factor);
}

/** macOS needs an application menu with the Edit roles — without one,
 *  Cmd+C/V/A do nothing in the renderer. Everything else stays minimal. */
function installMenu() {
	const template = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				// Manual checks report their result in Settings → General
				// (local builds too: there they only look, never install).
				{ label: "Check for Updates…", click: () => checkForUpdatesFromMenu() },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				// OWNED zoom (see applyZoom): the roles change zoomLevel
				// silently; these broadcast the factor and re-seat the
				// traffic lights. The renderer's --np-zoom depends on
				// hearing every change.
				{
					label: "Actual Size",
					accelerator: "CommandOrControl+0",
					click: () => applyZoom(BrowserWindow.getAllWindows()[0], 1),
				},
				{
					label: "Zoom In",
					accelerator: "CommandOrControl+Plus",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], +1),
				},
				{
					label: "Zoom Out",
					accelerator: "CommandOrControl+-",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], -1),
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ role: "windowMenu" },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ── «Repaso» desktop side (owner, 2026-11-04 — stage 2) ──────────────────
 * Tray (Abrir · Repasar ahora (N) · Salir), close-to-tray, login autostart
 * (--hidden: no window at boot) and the review notifications' minute clock.
 * The server owns every review rule: each tick asks POST
 * /api/review/notify for digest and evening, shows what it is told and
 * keeps the tray's due counter. All of it reads settings.json each tick,
 * so Settings changes apply within a minute. Failures are log lines. */
const REVIEW_CLOCK_MS = 60_000;
let tray = null;
let reviewDueCount = 0;
let appliedAutostart = null;
let reviewServerOrigin = null;
let reviewClockFailing = false;

function readSettingsFile() {
	try {
		return JSON.parse(fs.readFileSync(path.join(DATA_DIR(), "settings.json"), "utf8"));
	} catch {
		return null;
	}
}

/** Bring the app forward — reopening the window if it was closed to the
 *  tray — and optionally navigate it (allow-listed paths only). */
function showWindow(pathname) {
	try {
		const target = reviewDesktop.isNavigablePath(pathname) ? pathname : null;
		let win = BrowserWindow.getAllWindows()[0];
		if (!win) {
			const base = reviewServerOrigin;
			win = reopenWindow?.(target && base ? `${base}${target}` : undefined);
			return;
		}
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
		if (target) {
			const send = () => {
				try { win.webContents.send("np:navigate", target); } catch { /* window closed */ }
			};
			if (win.webContents.isLoadingMainFrame()) win.webContents.once("did-finish-load", send);
			else send();
		}
	} catch (err) {
		log(`showWindow failed: ${err?.message ?? err}`);
	}
}

function ensureTray(prefs) {
	try {
		if (!prefs.tray) {
			tray?.destroy();
			tray = null;
			return;
		}
		if (!tray) {
			const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
			tray = new Tray(icon);
			tray.on("click", () => showWindow());
		}
		const labels = reviewDesktop.trayLabels(prefs.language, reviewDueCount);
		tray.setToolTip(labels.tooltip);
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: labels.open, click: () => showWindow() },
				{ label: labels.review, enabled: reviewDueCount > 0, click: () => showWindow("/review") },
				{ type: "separator" },
				{ label: labels.quit, click: () => app.quit() },
			]),
		);
	} catch (err) {
		// No tray support on this desktop: closing the window quits again.
		log(`tray unavailable: ${err?.message ?? err}`);
		tray = null;
	}
}

/** Login autostart. Packaged builds only (dev never registers itself).
 *  Linux: an XDG autostart entry we own (marker line); Windows/macOS: the
 *  system login item. Re-applied at boot so a moved AppImage is followed. */
function applyAutostart(enabled) {
	if (!app.isPackaged || process.env.NP_DEV_URL || appliedAutostart === enabled) return;
	appliedAutostart = enabled;
	try {
		if (process.platform === "linux") {
			const file = path.join(app.getPath("appData"), "autostart", "naipes.desktop");
			if (enabled) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, reviewDesktop.linuxAutostartEntry(process.env.APPIMAGE || process.execPath));
			} else {
				let content = null;
				try { content = fs.readFileSync(file, "utf8"); } catch { /* absent */ }
				if (reviewDesktop.isOwnAutostartEntry(content)) fs.unlinkSync(file);
			}
		} else {
			app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled, args: enabled ? [reviewDesktop.HIDDEN_FLAG] : [] });
		}
		log(`autostart ${enabled ? "on" : "off"}`);
	} catch (err) {
		log(`autostart could not be ${enabled ? "enabled" : "disabled"}: ${err?.message ?? err}`);
	}
}

async function askReviewNotice(kind) {
	const res = await fetch(`${reviewServerOrigin}/api/review/notify?kind=${kind}`, {
		method: "POST",
		headers: desktopAPISecret ? { [DESKTOP_API_HEADER]: desktopAPISecret } : {},
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

function showReviewNotification(title, body, path) {
	try {
		if (!Notification?.isSupported?.()) return;
		const notice = new Notification({ title, body });
		// Exam notices name their page (allow-listed in showWindow).
		notice.on("click", () => showWindow(typeof path === "string" ? path : "/review"));
		notice.show();
	} catch (err) {
		log(`review notification failed: ${err?.message ?? err}`);
	}
}

async function reviewTick() {
	const prefs = reviewDesktop.desktopPrefs(readSettingsFile());
	applyAutostart(prefs.autostart);
	if (reviewServerOrigin) {
		try {
			for (const kind of ["digest", "evening"]) {
				const answer = await askReviewNotice(kind);
				if (typeof answer?.count === "number") reviewDueCount = answer.count;
				if (answer?.notify && typeof answer.title === "string") showReviewNotification(answer.title, answer.body ?? "", answer.path);
			}
			if (reviewClockFailing) log("review clock: server reachable again");
			reviewClockFailing = false;
		} catch (err) {
			// Log the first failure of a streak only (no minute-by-minute spam).
			if (!reviewClockFailing) log(`review clock: ${err?.message ?? err}`);
			reviewClockFailing = true;
		}
	}
	ensureTray(prefs);
}

async function main() {
	app.on("window-all-closed", () => {
		chatgpt?.pause();
		subscriptions?.pause();
		// macOS convention: the app stays resident, reactivated from the Dock.
		// With the tray on (Repaso, 2026-11-04) it stays resident everywhere:
		// the server keeps running for review notifications.
		if (process.platform !== "darwin" && !tray) app.quit();
	});

	// The child must not outlive us — cover every quit path.
	app.on("before-quit", killServer);
	process.on("exit", killServer);
	process.on("SIGHUP", killServer);

	await app.whenReady();

	// Dev mode: point at a running `next dev` server (NP_DEV_URL) — no
	// spawn, no packaging, full HMR. The rest of this shell still applies
	// (guards, menu, single instance).
	const devUrl = process.env.NP_DEV_URL;
	const url = devUrl ?? `http://127.0.0.1:${await freePort()}`;
	if (!devUrl) {
		desktopAPISecret = randomBytes(32).toString("hex");
		const ownedOrigin = new URL(url).origin;
		// All URLs, not only /api: remove the header again on external redirects.
		session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
			callback({ requestHeaders: desktopAPIHeaders(details, ownedOrigin, desktopAPISecret, [...trustedAppWindows]) });
		});
		chatgpt = createChatGPT({
			store: fileStore(path.join(app.getPath("userData"), "chatgpt-credentials.json")),
			openExternal: (target) => shell.openExternal(target),
			onChange: (value) => {
				chatgptChild?.send(value);
				for (const win of BrowserWindow.getAllWindows()) win.webContents.send("np:chatgpt:changed");
			},
		});
		subscriptions = createSubscriptions({
			directory: app.getPath("userData"),
			loadSDK: () => loadSubscriptionSDK(path.dirname(serverEntry())),
			openExternal: (target) => shell.openExternal(target),
			onChange: (snapshot) => {
				subscriptionChild?.send(snapshot);
				for (const win of BrowserWindow.getAllWindows()) win.webContents.send("np:subscriptions:changed");
			},
		});
		await subscriptions.ready;
		log(`starting server: ${serverEntry()}`);
		log(`data dir: ${DATA_DIR()}${fs.existsSync(AUTH_FILE()) ? " · auth.json: present" : " · auth.json: ABSENT (no BYOK keys yet)"}`);
		await startServer(new URL(url).port);
		await waitUntilUp(url);
		log(`server up: ${url}`);
	} else {
		log(`dev mode: ${devUrl}`);
	}

	// Renderer controls contain no token/URL/code operation. The separate server
	// child is the only recipient of credential leases over inherited IPC.
	ipcMain.handle("np:chatgpt:control", async (event, command) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) return { error: "Untrusted desktop request." };
		if (!chatgpt || !serverProcess?.connected) return { available: false, pending: false, activeId: null, accounts: [], error: "ChatGPT sign-in requires the desktop app's private server connection. Browser-only and externally launched development servers keep API-key connections." };
		return chatGPTControl(command, chatgpt);
	});

	ipcMain.handle("np:subscriptions:control", async (event, command) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		if (!subscriptions || !serverProcess?.connected) {
			if (command?.op === "status") return [];
			throw new Error("Subscription sign-in requires the desktop app's private server connection.");
		}
		return subscriptionControl(command, subscriptions);
	});

	// The dev shell has no browser tabs. Only a one-use action on its own
	// Next server may be resolved here; never accept an arbitrary external URL.
	ipcMain.handle("np:subscriptions:web-browser", async (event, action) => {
		if (!devUrl || !trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted development request.");
		await openWebSubscriptionBrowser(action, new URL(url).origin, { openExternal: (target) => shell.openExternal(target) });
	});

	installMenu();

	// Auto-update (Wave C): wire the updater before the window so the
	// banner channel is live from first paint; the first check and the 24h
	// interval fire after it below. setupAutoUpdater's contract: failures
	// are log lines — this can never block boot.
	setupAutoUpdater();
	ipcMain.on("np:update-install", () => installUpdateNow());
	ipcMain.handle("np:update:get", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		return updateState;
	});
	ipcMain.handle("np:update:check", (event) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		checkForUpdates({ manual: true });
	});

	// Sidebar-at-narrow-window (owner, 2026-09-17): the renderer auto-closes
	// the sidebar below SIDEBAR_AUTOCLOSE (928px); opening it again at that
	// width asks the window to widen instead — the layout never has to
	// accommodate a narrow window + open sidebar. Top-left stays fixed, the
	// window grows right. No-op when already wide.
	// The renderer's first paint can race did-finish-load — it asks for
	// the current factor itself (mirrors "np:zoom" pushes).
	// Settings → Knowledge folder: the native folder picker for the folder path.
	// Returns the chosen absolute path, or null when cancelled.
	ipcMain.handle("np:pick-folder", async (event, defaultPath) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		const win = BrowserWindow.fromWebContents(event.sender);
		const result = await dialog.showOpenDialog(win, {
			properties: ["openDirectory"],
			...(typeof defaultPath === "string" && defaultPath ? { defaultPath } : {}),
		});
		return result.canceled ? null : result.filePaths[0] ?? null;
	});
	// Conocimiento → an idea's document source (phase 2, 2026-11-04): open a
	// knowledge-folder file with the system viewer. Only a regular file of a
	// readable kind INSIDE the configured folder (realpath-checked, so no
	// symlink or ".." escape); anything else answers false.
	ipcMain.handle("np:open-source", async (event, relPath) => {
		if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) throw new Error("Untrusted desktop request.");
		const target = knowledgeSourcePath(DATA_DIR(), relPath);
		return target ? (await shell.openPath(target)) === "" : false;
	});
	ipcMain.handle("np:zoom:get", (event) => BrowserWindow.fromWebContents(event.sender)?.webContents.getZoomFactor() ?? 1);
	// The renderer's effective theme (light/dark): repaint the native
	// window background and, on Windows/Linux, the title-bar overlay.
	ipcMain.on("np:set-theme", (event, theme) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || !trustedAppWindows.has(win)) return;
		const chrome = THEME_CHROME[theme === "light" ? "light" : "dark"];
		win.setBackgroundColor(chrome.background);
		if (process.platform !== "darwin") {
			try {
				win.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.symbol });
			} catch {
				// No overlay on this window (e.g. fullscreen): nothing to repaint.
			}
		}
	});
	// Profile menu → «Abrir la carpeta de datos»: the userData folder in
	// the system file manager (data, logs, keys file — never edited here).
	ipcMain.on("np:open-data-folder", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || !trustedAppWindows.has(win)) return;
		void shell.openPath(app.getPath("userData"));
	});
	ipcMain.on("np:expand-window", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return;
		const { x, y, width, height } = win.getBounds();
		const target = SIDEBAR_AUTOCLOSE;
		if (width < target) win.setBounds({ x, y, width: target, height });
	});
	reopenWindow = (target = url) => { chatgpt?.resume(); subscriptions?.resume(); return createWindow(target); };
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) reopenWindow();
	});
	// Repaso: tray first (a --hidden autostart launch needs it to be
	// reachable), then the window unless this is a hidden launch.
	reviewServerOrigin = new URL(url).origin;
	const startPrefs = reviewDesktop.desktopPrefs(readSettingsFile());
	ensureTray(startPrefs);
	if (process.argv.includes(reviewDesktop.HIDDEN_FLAG) && tray) {
		log("hidden launch (autostart): window stays closed, Naipes waits in the tray");
	} else {
		createWindow(url);
		log(`window open: ${url}`);
	}
	void reviewTick();
	setInterval(() => void reviewTick(), REVIEW_CLOCK_MS);
	// Startup + 24h checks stay main-owned and read the current preference.
	// No renderer subscription is required; late loads retrieve the snapshot.
	if (autoUpdater || localUpdateCheck) {
		checkForUpdates();
		setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
	}
}