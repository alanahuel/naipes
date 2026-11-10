/** Actual shell functions with fake Electron/updater/filesystem. No app,
 * profile, network, timer or updater download/install operation is run. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

// platform: electron-updater only runs off macOS since 2026-11-06 (unsigned
// → notice-only), so the updater suites default to Linux. packageType is
// resources/package-type (the AUR package writes "pacman"); absent → ENOENT.
function fixture({ packaged = true, updaterMissing = false, localBuild = false, argv = [] as string[], platform = "linux", packageType = null as string | null } = {}) {
	let settings: string | Error = JSON.stringify({ version: 1, general: { autoUpdate: true } });
	// Local builds (stage 0b): files main writes (local-update.json), the
	// fake GitHub answer, desktop notifications shown, urls opened.
	const files = new Map<string, string>();
	let release: { tag_name: string; html_url?: string } | Error = { tag_name: "v0.1.0" };
	const fetches: string[] = [];
	const notifications: { title: string; body: string; click: () => void }[] = [];
	const opened: string[] = [];
	class FakeNotification extends EventEmitter {
		static isSupported() { return true; }
		opts: { title: string; body: string };
		constructor(opts: { title: string; body: string }) { super(); this.opts = opts; }
		show() { notifications.push({ ...this.opts, click: () => this.emit("click") }); }
	}
	// «Repaso» (stage 2): review notify answers per kind, tray instances.
	const reviewAnswers: Record<string, unknown> = { digest: { notify: false, count: 0 }, evening: { notify: false, count: 0 } };
	const reviewCalls: { url: string; headers: Record<string, string> }[] = [];
	const trays: FakeTray[] = [];
	class FakeTray extends EventEmitter {
		tooltip = ""; menu: { label?: string; enabled?: boolean; click?: () => void }[] = []; destroyed = false;
		constructor() { super(); trays.push(this); }
		setToolTip(t: string) { this.tooltip = t; }
		setContextMenu(m: typeof this.menu) { this.menu = m; }
		destroy() { this.destroyed = true; }
	}
	const fakeFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
		if (url.includes("/api/review/notify")) {
			reviewCalls.push({ url, headers: init?.headers ?? {} });
			// One call per minute (perf, 2026-11-10): kind=all answers
			// digest, evening and calendar in that order.
			const body = { answers: ["digest", "evening", "calendar"].map((kind) => reviewAnswers[kind]).filter(Boolean) };
			return { ok: true, status: 200, json: async () => body };
		}
		fetches.push(url);
		if (release instanceof Error) throw release;
		const body = release;
		return { ok: true, status: 200, json: async () => body };
	};
	const settingsReads: string[] = [];
	const packageTypeReads: string[] = [];
	const order: string[] = [];
	const intervals: { callback: () => void; delay: number }[] = [];
	const handles = new Map<string, (event: unknown) => unknown>();
	const windows: FakeWindow[] = [];
	let enumerationFails = false;
	let userData = "/fixture/custom-user-data";
	let menu: { submenu?: { label?: string; click?: () => void }[] }[] = [];
	class FakeUpdater extends EventEmitter {
		checks = 0;
		autoDownload = false;
		autoInstallOnAppQuit = false;
		result: object | null = { updateInfo: { version: "0.3.7" } };
		failure: Error | null = null;
		checkForUpdates() {
			this.checks++;
			this.emit("checking-for-update");
			if (this.failure) return Promise.reject(this.failure);
			if (this.result) this.emit("update-not-available", { version: "0.3.7" });
			return Promise.resolve(this.result);
		}
		quitAndInstall() { order.push("install"); }
	}
	const updater = new FakeUpdater();
	class FakeWebContents extends EventEmitter {
		mainFrame = { url: "http://127.0.0.1:9000/" };
		messages: { channel: string; value: unknown }[] = [];
		loading = false;
		fails = false;
		send(channel: string, value: unknown) {
			if (this.fails) throw new Error("window destroyed");
			this.messages.push({ channel, value: JSON.parse(JSON.stringify(value)) });
		}
		isLoadingMainFrame() { return this.loading; }
		setWindowOpenHandler() {}
		getZoomFactor() { return 1; }
	}
	class FakeWindow extends EventEmitter {
		webContents = new FakeWebContents();
		minimized = false;
		focused = false;
		constructor() { super(); windows.push(this); }
		loadURL() { this.webContents.loading = true; }
		isMinimized() { return this.minimized; }
		restore() { this.minimized = false; }
		focus() { this.focused = true; }
		show() {}
		static getAllWindows() {
			if (enumerationFails) throw new Error("window enumeration failed");
			return windows;
		}
		static fromWebContents(contents: FakeWebContents) { return windows.find(win => win.webContents === contents); }
	}
	const app = Object.assign(new EventEmitter(), {
		isPackaged: packaged,
		name: "Naipes",
		setName() {},
		getPath: () => userData,
		setPath: (_: string, value: string) => { userData = value; },
		requestSingleInstanceLock: () => false,
		quit() {},
		whenReady: async () => {},
		commandLine: { appendSwitch() {} },
	});
	const electron = {
		app, BrowserWindow: FakeWindow,
		Menu: { buildFromTemplate: (value: typeof menu) => value, setApplicationMenu: (value: typeof menu) => { menu = value; } },
		ipcMain: { on() {}, handle: (channel: string, fn: (event: unknown) => unknown) => handles.set(channel, fn) },
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
		Notification: FakeNotification,
		Tray: FakeTray,
		nativeImage: { createFromPath: (p: string) => ({ path: p }) },
		shell: { openExternal: async (target: string) => { opened.push(target); } },
	};
	const context = createContext({
		require: (id: string) => {
			if (id === "electron") return electron;
			if (id === "electron-updater") {
				if (updaterMissing) throw new Error("missing updater");
				return { autoUpdater: updater };
			}
			if (id === "../package.json" && localBuild) {
				return { ...mainRequire("../package.json"), version: "0.1.0", npLocalBuild: true };
			}
			if (id === "node:fs") return {
				readFileSync: (file: string) => {
					if (file.endsWith("package-type")) {
						packageTypeReads.push(file);
						if (packageType === null) throw new Error("ENOENT");
						return packageType;
					}
					if (file.endsWith("local-update.json")) {
						if (!files.has(file)) throw new Error("ENOENT");
						return files.get(file);
					}
					settingsReads.push(file);
					if (settings instanceof Error) throw settings;
					return settings;
				}, mkdirSync() {}, appendFileSync() {},
				writeFileSync: (file: string, data: string) => { files.set(file, data); },
			};
			return mainRequire(id);
		},
		process: { argv, env: { NP_DEV_URL: "http://127.0.0.1:9000" } as Record<string, string | undefined>, platform, resourcesPath: "/fixture/resources", on() {} },
		__dirname: path.dirname(mainFile), URL,
		setInterval: (callback: () => void, delay: number) => intervals.push({ callback, delay }),
		setTimeout() {},
		fixtureChild: { kill: (signal: string) => order.push(signal) },
		fetch: fakeFetch,
		AbortSignal,
	});
	runInContext(mainSource, context, { filename: mainFile });
	const run = (code: string) => runInContext(code, context);
	return {
		run, updater, windows, handles, settingsReads, packageTypeReads, order, app,
		/** The updater's timers only (the review clock adds a 60s one). */
		get intervals() { return intervals.filter((i) => i.delay === 24 * 60 * 60 * 1000); },
		reviewIntervals: () => intervals.filter((i) => i.delay === 60_000),
		files, fetches, notifications, opened, reviewAnswers, reviewCalls, trays,
		setRelease: (value: typeof release) => { release = value; },
		/** Let an async local check settle (fetch + json + report). */
		settle: async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); },
		setSettings: (value: unknown) => { settings = JSON.stringify(value); },
		setSettingsFailure: (value: string | Error) => { settings = value; },
		setEnumerationFailure: (value: boolean) => { enumerationFails = value; },
		window: () => new FakeWindow(),
		state: () => JSON.parse(JSON.stringify(run("updateState"))),
		check: async (manual = false) => { run(`checkForUpdates({ manual: ${manual} })`); await Promise.resolve(); await Promise.resolve(); },
		menuCheck: () => menu[0]!.submenu!.find(item => item.label === "Check for Updates…")!.click!(),
	};
}

describe("automatic-update preference gate", () => {
	it("explicit OFF skips automatic checks, but manual checks still run without reading the preference", async () => {
		const f = fixture();
		f.setSettings({ general: { autoUpdate: false } });
		f.run("setupAutoUpdater()");
		await f.check();
		assert.equal(f.updater.checks, 0);
		assert.deepEqual(f.settingsReads, ["/fixture/custom-user-data-dev/data/settings.json"]);
		await f.check(true);
		assert.equal(f.updater.checks, 1);
		assert.equal(f.settingsReads.length, 1);
		assert.equal(f.updater.autoDownload, true);
		assert.equal(f.updater.autoInstallOnAppQuit, true);
	});

	for (const [label, setting] of [
		["ON", { general: { autoUpdate: true } }], ["absent field", { general: {} }],
		["absent section", { version: 1 }], ["null", null], ["non-boolean", { general: { autoUpdate: "false" } }],
	] as const) {
		it(`${label} keeps automatic checks enabled`, async () => {
			const f = fixture(); f.setSettings(setting); f.run("setupAutoUpdater()"); await f.check();
			assert.equal(f.updater.checks, 1);
		});
	}
	for (const [label, failure] of [["missing", new Error("ENOENT")], ["unreadable", new Error("EACCES")], ["corrupt", "{nope"]] as const) {
		it(`${label} settings keep automatic checks enabled`, async () => {
			const f = fixture(); f.setSettingsFailure(failure); f.run("setupAutoUpdater()"); await f.check();
			assert.equal(f.updater.checks, 1);
		});
	}

	it("re-reads the setting on each check, without triggering a check merely when saved", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.setSettings({ general: { autoUpdate: false } }); await f.check();
		f.setSettings({ general: { autoUpdate: true } });
		assert.equal(f.updater.checks, 0);
		await f.check();
		f.setSettings({ general: { autoUpdate: false } }); await f.check();
		assert.equal(f.updater.checks, 1);
		assert.equal(f.settingsReads.length, 3);
	});

	for (const label of ["unpackaged", "missing updater"] as const) {
		it(`${label} stays unavailable, not a saved OFF preference`, async () => {
			const f = fixture({ packaged: label !== "unpackaged", updaterMissing: label === "missing updater" });
			f.run("setupAutoUpdater()"); await f.check(true); await f.check();
			assert.equal(f.updater.checks, 0);
			assert.equal(f.settingsReads.length, 0);
			assert.equal(f.state().status, "disabled");
		});
	}
});

describe("status observation never controls the updater", () => {
	it("reports events, but a staged update stays visible without suppressing future checks", async () => {
		const f = fixture(); const win = f.window(); f.run("setupAutoUpdater()");
		f.updater.emit("checking-for-update"); assert.equal(f.state().status, "checking");
		f.updater.emit("update-available", { version: "0.3.8" });
		assert.equal(f.state().status, "downloading"); assert.equal(f.state().version, "0.3.8");
		f.updater.emit("update-downloaded", { version: "0.3.8" });
		const ready = f.state();
		await f.check();
		f.updater.emit("error", new Error("failure with sensitive diagnostic details"));
		assert.equal(f.updater.checks, 1);
		assert.deepEqual(f.state(), ready);
		f.updater.emit("update-downloaded", { version: "0.3.9" });
		assert.equal(f.state().version, "0.3.9");
		assert.ok(f.state().revision > ready.revision);
		assert.equal(win.webContents.messages.at(-1)!.channel, "np:update-status");
	});

	for (const status of ["checking", "downloading", "error", "disabled", "downloaded"]) {
		it(`a ${status} display state does not block a future automatic check`, async () => {
			const f = fixture(); f.run(`setupAutoUpdater(); reportUpdateStatus("${status}")`); await f.check();
			assert.equal(f.updater.checks, 1);
		});
	}

	it("check failures settle to a generic error and later checks still run", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.failure = new Error("private endpoint/diagnostic detail"); await f.check();
		assert.equal(f.state().status, "error");
		assert.ok(!JSON.stringify(f.state()).includes("private"));
		f.updater.failure = null; await f.check();
		assert.equal(f.updater.checks, 2); assert.equal(f.state().status, "up-to-date");
	});

	it("a declined check makes no up-to-date claim", async () => {
		const f = fixture(); f.updater.result = null; f.run("setupAutoUpdater()"); await f.check(true);
		assert.equal(f.state().status, "idle");
	});

	it("window enumeration/send failures do not break checks or the next window's notification", async () => {
		const f = fixture(); const bad = f.window(); bad.webContents.fails = true; const good = f.window();
		f.run("setupAutoUpdater()"); await f.check();
		assert.equal(good.webContents.messages.at(-1)!.channel, "np:update-status");
		f.setEnumerationFailure(true); await f.check();
		f.setEnumerationFailure(false); await f.check();
		assert.equal(f.updater.checks, 3);
	});

	it("OFF does not cancel in-flight events or alter staging/install-on-quit; Restart kills server first", async () => {
		const f = fixture(); f.run("setupAutoUpdater()");
		f.updater.emit("update-available", { version: "0.3.8" });
		f.setSettings({ general: { autoUpdate: false } });
		f.updater.emit("update-downloaded", { version: "0.3.8" }); await f.check();
		assert.equal(f.state().status, "downloaded"); assert.equal(f.updater.checks, 0);
		assert.equal(f.updater.autoDownload, true); assert.equal(f.updater.autoInstallOnAppQuit, true);
		f.run("serverProcess = fixtureChild; installUpdateNow()");
		assert.deepEqual(f.order, ["SIGTERM", "install"]);
	});
});

describe("startup, timer, trusted IPC and menu wiring", () => {
	it("starts and retains the 24h timer without any Settings subscription, checking current preference each time", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } });
		await f.run("main()");
		assert.equal(f.updater.checks, 0);
		assert.equal(f.intervals.length, 1); assert.equal(f.intervals[0]!.delay, 24 * 60 * 60 * 1000);
		f.setSettings({ general: { autoUpdate: true } }); f.intervals[0]!.callback(); await Promise.resolve();
		assert.equal(f.updater.checks, 1);
		f.windows.length = 0; f.intervals[0]!.callback(); await Promise.resolve();
		assert.equal(f.updater.checks, 2, "checks also work with every window closed");
	});

	it("ON/default boot checks immediately and status never disables the scheduled check", async () => {
		const f = fixture(); f.setSettings({ version: 1 }); await f.run("main()");
		assert.equal(f.updater.checks, 1);
		f.run('reportUpdateStatus("downloading", "0.3.8")'); f.intervals[0]!.callback(); await Promise.resolve();
		assert.equal(f.updater.checks, 2);
	});

	it("snapshot/manual IPC accepts only an owned main frame and snapshot reads never check", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		const sender = f.windows[0]!.webContents;
		const event = { sender, senderFrame: sender.mainFrame };
		const get = f.handles.get("np:update:get")!; const check = f.handles.get("np:update:check")!;
		assert.equal((get(event) as { status: string }).status, "idle"); assert.equal(f.updater.checks, 0);
		check(event); assert.equal(f.updater.checks, 1);
		for (const bad of [
			{ sender: {}, senderFrame: sender.mainFrame },
			{ sender, senderFrame: { url: sender.mainFrame.url } },
		]) {
			assert.throws(() => get(bad), /Untrusted/); assert.throws(() => check(bad), /Untrusted/);
		}
		sender.mainFrame.url = "https://untrusted.invalid/";
		assert.throws(() => check(event), /Untrusted/);
		assert.equal(f.updater.checks, 1);
	});

	it("menu restores/focuses a minimized window, opens General, and manually checks while OFF", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		const win = f.windows[0]!; win.webContents.loading = false; win.minimized = true;
		f.menuCheck();
		assert.equal(win.minimized, false); assert.equal(win.focused, true);
		assert.ok(win.webContents.messages.some(message => message.channel === "np:open-settings" && message.value === "general"));
		assert.equal(f.updater.checks, 1);
	});

	it("menu reopens a window and delivers General after load; loading existing windows are covered too", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		f.windows.length = 0; f.menuCheck();
		assert.equal(f.windows.length, 1); assert.equal(f.updater.checks, 1);
		const win = f.windows[0]!;
		assert.ok(!win.webContents.messages.some(message => message.channel === "np:open-settings"));
		win.webContents.emit("did-finish-load");
		assert.ok(win.webContents.messages.some(message => message.channel === "np:open-settings"));
		f.menuCheck(); win.webContents.emit("did-finish-load");
		assert.equal(win.webContents.messages.filter(message => message.channel === "np:open-settings").length, 2);
	});

	it("menu navigation failure does not prevent its manual check", async () => {
		const f = fixture(); f.setSettings({ general: { autoUpdate: false } }); await f.run("main()");
		f.windows[0]!.webContents.fails = true; f.windows[0]!.webContents.loading = false;
		f.menuCheck(); assert.equal(f.updater.checks, 1);
	});
});

describe("local builds: notice-only update checks (owner 2026-11-04, stage 0b)", () => {
	const newer = { tag_name: "v0.2.0", html_url: "https://github.com/alanahuel/naipes/releases/tag/v0.2.0" };

	it("never touches electron-updater, asks GitHub's releases/latest instead", async () => {
		const f = fixture({ localBuild: true });
		f.run("setupAutoUpdater()");
		assert.equal(f.state().status, "idle");
		assert.equal(f.state().notice, "local");
		await f.check(); await f.settle();
		assert.equal(f.updater.checks, 0);
		assert.deepEqual(f.fetches, ["https://api.github.com/repos/alanahuel/naipes/releases/latest"]);
		assert.equal(f.state().status, "up-to-date");
	});

	it("a newer release becomes 'available' with its page, plus ONE desktop notification per version", async () => {
		const f = fixture({ localBuild: true });
		f.setRelease(newer);
		f.run("setupAutoUpdater()");
		await f.check(); await f.settle();
		assert.equal(f.state().status, "available");
		assert.equal(f.state().version, "0.2.0");
		assert.equal(f.state().url, newer.html_url);
		assert.equal(f.notifications.length, 1);
		assert.match(f.notifications[0]!.title, /0\.2\.0 está disponible/);
		f.notifications[0]!.click();
		assert.deepEqual(f.opened, [newer.html_url]);
		// Same version again (24h timer, manual check): no second notification.
		await f.check(); await f.settle();
		await f.check(true); await f.settle();
		assert.equal(f.notifications.length, 1);
		assert.equal(f.state().status, "available");
		// A later version is announced once more.
		f.setRelease({ tag_name: "v0.3.0" });
		await f.check(); await f.settle();
		assert.equal(f.notifications.length, 2);
		assert.equal(f.state().url, "https://github.com/alanahuel/naipes/releases/tag/v0.3.0");
	});

	it("the announcement survives a restart (persisted in userData)", async () => {
		const first = fixture({ localBuild: true });
		first.setRelease(newer); first.run("setupAutoUpdater()");
		await first.check(); await first.settle();
		const second = fixture({ localBuild: true });
		for (const [k, v] of first.files) second.files.set(k, v);
		second.setRelease(newer); second.run("setupAutoUpdater()");
		await second.check(); await second.settle();
		assert.equal(second.state().status, "available");
		assert.equal(second.notifications.length, 0);
	});

	it("notifies in English when the interface language is English", async () => {
		const f = fixture({ localBuild: true });
		f.setSettings({ general: { language: "en" } });
		f.setRelease(newer); f.run("setupAutoUpdater()");
		await f.check(); await f.settle();
		assert.match(f.notifications[0]!.title, /0\.2\.0 is available/);
	});

	it("obeys the automatic-updates toggle; manual checks still run", async () => {
		const f = fixture({ localBuild: true });
		f.setSettings({ general: { autoUpdate: false } });
		f.setRelease(newer); f.run("setupAutoUpdater()");
		await f.check(); await f.settle();
		assert.equal(f.fetches.length, 0);
		await f.check(true); await f.settle();
		assert.equal(f.fetches.length, 1);
		assert.equal(f.state().status, "available");
	});

	it("offline / GitHub errors settle to a generic error, never a notification", async () => {
		const f = fixture({ localBuild: true });
		f.setRelease(new Error("getaddrinfo ENOTFOUND api.github.com"));
		f.run("setupAutoUpdater()");
		await f.check(); await f.settle();
		assert.equal(f.state().status, "error");
		assert.equal(f.notifications.length, 0);
		f.setRelease(newer);
		await f.check(); await f.settle();
		assert.equal(f.state().status, "available");
	});

	it("an older or equal release is up to date", async () => {
		const f = fixture({ localBuild: true });
		f.setRelease({ tag_name: "v0.0.9" }); f.run("setupAutoUpdater()");
		await f.check(); await f.settle();
		assert.equal(f.state().status, "up-to-date");
		assert.equal(f.notifications.length, 0);
	});

	it("boot checks and keeps the 24h timer; the menu offers a manual check", async () => {
		const f = fixture({ localBuild: true });
		await f.run("main()"); await f.settle();
		assert.equal(f.fetches.length, 1);
		assert.equal(f.intervals.length, 1);
		f.menuCheck(); await f.settle();
		assert.equal(f.fetches.length, 2);
	});
});

describe("«Repaso» desktop side (owner 2026-11-04, stage 2)", () => {
	it("boot: tray with Abrir · Repasar ahora · Salir, a 60s review clock, and the window", async () => {
		const f = fixture();
		await f.run("main()"); await f.settle();
		assert.equal(f.trays.length, 1);
		assert.deepEqual(JSON.parse(JSON.stringify(f.trays[0]!.menu.filter((i) => i.label).map((i) => i.label))), ["Abrir Naipes", "Repasar ahora", "Salir"]);
		assert.equal(f.reviewIntervals().length, 1);
		assert.equal(f.windows.length, 1);
		assert.deepEqual(f.reviewCalls.map((c) => new URL(c.url).search), ["?kind=all"], "one call per minute for all three kinds");
	});

	it("a --hidden (autostart) launch keeps the window closed while the tray exists", async () => {
		const f = fixture({ argv: ["--hidden"] });
		await f.run("main()"); await f.settle();
		assert.equal(f.windows.length, 0);
		assert.equal(f.trays.length, 1);
	});

	it("the tray switch off: no tray, and --hidden still opens the window (never unreachable)", async () => {
		const f = fixture({ argv: ["--hidden"] });
		f.setSettings({ desktop: { tray: false } });
		await f.run("main()"); await f.settle();
		assert.equal(f.trays.length, 0);
		assert.equal(f.windows.length, 1);
	});

	it("each tick shows what the server says, keeps the due count, and a click opens /review", async () => {
		const f = fixture();
		await f.run("main()"); await f.settle();
		f.reviewAnswers.digest = { notify: true, count: 12, title: "Hoy toca repasar 12 ideas", body: "Estoicismo (6) y FÍSICA (6). Pulsa para empezar." };
		f.reviewAnswers.evening = { notify: false, count: 12 };
		f.reviewIntervals()[0]!.callback(); await f.settle();
		const shown = f.notifications.filter((n) => n.title.startsWith("Hoy toca"));
		assert.equal(shown.length, 1);
		assert.equal(f.trays[0]!.menu.find((i) => i.label?.startsWith("Repasar"))!.label, "Repasar ahora (12)");
		assert.equal(f.trays[0]!.menu.find((i) => i.label?.startsWith("Repasar"))!.enabled, true);
		shown[0]!.click();
		// The window is still loading: navigation waits for did-finish-load.
		assert.equal(f.windows[0]!.webContents.messages.some((m) => m.channel === "np:navigate"), false);
		f.windows[0]!.webContents.emit("did-finish-load");
		const nav = f.windows[0]!.webContents.messages.filter((m) => m.channel === "np:navigate");
		assert.deepEqual(nav.map((m) => m.value), ["/review"]);
	});

	it("closing every window quits only without a tray", async () => {
		let quits = 0;
		const f = fixture();
		f.app.quit = () => { quits++; };
		f.run("process.platform = 'linux'");
		await f.run("main()"); await f.settle();
		f.app.emit("window-all-closed");
		assert.equal(quits, 0, "the tray keeps Naipes resident");
		f.setSettings({ desktop: { tray: false } });
		f.reviewIntervals()[0]!.callback(); await f.settle();
		assert.equal(f.trays[0]!.destroyed, true);
		f.app.emit("window-all-closed");
		assert.equal(quits, 1);
	});

	it("Linux autostart: writes our XDG entry (hidden launch), removes only our own", async () => {
		const f = fixture();
		f.run("process.platform = 'linux'; process.env.NP_DEV_URL = undefined; process.env.APPIMAGE = '/opt/N/Naipes.AppImage'");
		f.run("applyAutostart(true)");
		const file = [...f.files.keys()].find((k) => k.endsWith("autostart/naipes.desktop"))!;
		assert.ok(file);
		assert.match(f.files.get(file)!, /^Exec=\/opt\/N\/Naipes.AppImage --hidden$/m);
	});

	it("a dev shell never registers autostart", async () => {
		const f = fixture();
		f.run("process.platform = 'linux'; applyAutostart(true)");
		assert.equal([...f.files.keys()].some((k) => k.includes("autostart")), false);
	});
});

describe("notice-only copies: macOS and AUR installs (owner 2026-11-06)", () => {
	const newer = { tag_name: "v99.0.0", html_url: "https://github.com/alanahuel/naipes/releases/tag/v99.0.0" };

	it("macOS never loads electron-updater: notice-only, with the release page", async () => {
		const f = fixture({ platform: "darwin" });
		f.setRelease(newer); f.run("setupAutoUpdater()");
		assert.equal(f.state().notice, "mac");
		await f.check(); await f.settle();
		assert.equal(f.updater.checks, 0);
		assert.equal(f.state().status, "available");
		assert.equal(f.state().url, newer.html_url);
		assert.equal(f.notifications.length, 1);
		assert.match(f.notifications[0]!.body, /descargarla/);
		f.notifications[0]!.click();
		assert.deepEqual(f.opened, [newer.html_url]);
		assert.equal(f.packageTypeReads.length, 0, "package-type is a Linux-only question");
	});

	it("an AUR install (package-type pacman) is notice-only, pointing at the package manager — no page", async () => {
		const f = fixture({ packageType: "pacman\n" });
		f.setRelease(newer); f.run("setupAutoUpdater()");
		assert.equal(f.state().notice, "pacman");
		await f.check(); await f.settle();
		assert.equal(f.updater.checks, 0);
		assert.equal(f.state().status, "available");
		assert.equal(f.state().url, null);
		assert.match(f.notifications[0]!.body, /paru -Syu/);
		f.notifications[0]!.click();
		assert.deepEqual(f.opened, []);
	});

	for (const packageType of [null, "deb", "rpm"]) {
		it(`Linux with package-type ${packageType} keeps electron-updater`, async () => {
			const f = fixture({ packageType }); f.run("setupAutoUpdater()"); await f.check();
			assert.equal(f.state().notice, null);
			assert.equal(f.updater.checks, 1);
			assert.deepEqual(f.fetches, []);
		});
	}

	it("Windows keeps electron-updater and never reads package-type", async () => {
		const f = fixture({ platform: "win32" }); f.run("setupAutoUpdater()"); await f.check();
		assert.equal(f.updater.checks, 1);
		assert.equal(f.packageTypeReads.length, 0);
	});

	it("a local build stays 'local' even on macOS or with package-type pacman", () => {
		for (const opts of [{ platform: "darwin" }, { packageType: "pacman" }]) {
			const f = fixture({ localBuild: true, ...opts }); f.run("setupAutoUpdater()");
			assert.equal(f.state().notice, "local");
		}
	});

	it("an unpackaged mac shell stays disabled (dev never checks)", async () => {
		const f = fixture({ platform: "darwin", packaged: false }); f.run("setupAutoUpdater()"); await f.check(true); await f.settle();
		assert.equal(f.state().status, "disabled");
		assert.deepEqual(f.fetches, []);
	});
});
