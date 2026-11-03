/*
 * Preload (2026-09-17, narrow-window wave): the ONLY bridge between the
 * sandboxed renderer and the main process. contextIsolation + sandbox are
 * on (electron/main.cjs), so this file is the renderer's entire access to
 * Electron — keep it a minimal, explicit API surface.
 *
 *   window.np.platform — read-only OS identity for native window-control
 *   gutters (darwin: left traffic lights; win32/linux: right overlay).
 *
 *   window.np.expandWindow() — widen the window to the sidebar auto-close
 *   threshold (928px) when the sidebar is opened below it. The main
 *   process clamps: no-op if the window is already wide enough.
 *
 *   window.np.onZoom(cb) / window.np.getZoom() — the zoom truth (owner
 *   round 7, 2026-10-05): every ⌘±/⌘0 change arrives as "np:zoom" with
 *   the new factor; getZoom covers the first-paint race. The renderer
 *   publishes it as --np-zoom so physical-constant lengths (the traffic-
 *   light gutter) can divide by it.
 *
 *   window.np.onUpdateStatus(cb) / window.np.installUpdate() — the
 *   auto-update channel (Wave C, 2026-10-10): "np:update-status" pushes
 *   {status, version, revision} on updater events; installUpdate asks main
 *   to kill the server and quit-and-install. getUpdateState retrieves the
 *   snapshot for a late subscriber; checkForUpdates requests a manual
 *   check (including download/install-on-quit, even with automatic checks OFF).
 *
 *   window.np.onOpenSettings(cb) — menu navigation, buffered until React
 *   subscribes after a window is reopened. Browser builds have no bridge.
 *
 * Channel names are mirrored in electron/main.cjs — keep them in sync.
 */
const { contextBridge, ipcRenderer } = require("electron");

let openSettingsListener = null;
let pendingOpenSettings = null;
ipcRenderer.on("np:open-settings", (_event, section) => {
	if (openSettingsListener) openSettingsListener(section);
	else pendingOpenSettings = section;
});

contextBridge.exposeInMainWorld("np", {
	platform: process.platform,
	...(process.argv?.includes("--np-web-subscriptions") ? {
		subscriptionTransport: "web",
		openSubscriptionBrowser: (action) => ipcRenderer.invoke("np:subscriptions:web-browser", action),
	} : {}),
	chatgpt: {
		status: () => ipcRenderer.invoke("np:chatgpt:control", { op: "status" }),
		login: (id) => ipcRenderer.invoke("np:chatgpt:control", { op: "login", id }),
		cancel: () => ipcRenderer.invoke("np:chatgpt:control", { op: "cancel" }),
		select: (id) => ipcRenderer.invoke("np:chatgpt:control", { op: "select", id }),
		disconnect: (id) => ipcRenderer.invoke("np:chatgpt:control", { op: "disconnect", id }),
		logout: (id) => ipcRenderer.invoke("np:chatgpt:control", { op: "logout", id }),
		consent: (enabled) => ipcRenderer.invoke("np:chatgpt:control", { op: "consent", enabled }),
		onChange: (cb) => {
			const listener = () => cb();
			ipcRenderer.on("np:chatgpt:changed", listener);
			return () => ipcRenderer.removeListener("np:chatgpt:changed", listener);
		},
	},
	subscriptions: {
		status: () => ipcRenderer.invoke("np:subscriptions:control", { op: "status" }),
		login: (providerId, enabled) => ipcRenderer.invoke("np:subscriptions:control", { op: "login", providerId, enabled }),
		cancel: (providerId) => ipcRenderer.invoke("np:subscriptions:control", { op: "cancel", providerId }),
		respond: (providerId, attemptId, promptId, value) => ipcRenderer.invoke("np:subscriptions:control", { op: "respond", providerId, attemptId, promptId, value }),
		open: (providerId, attemptId, actionId) => ipcRenderer.invoke("np:subscriptions:control", { op: "open", providerId, attemptId, actionId }),
		retry: (providerId) => ipcRenderer.invoke("np:subscriptions:control", { op: "retry", providerId }),
		disconnect: (providerId) => ipcRenderer.invoke("np:subscriptions:control", { op: "disconnect", providerId }),
		consent: (providerId, enabled) => ipcRenderer.invoke("np:subscriptions:control", { op: "consent", providerId, enabled }),
		onChange: (cb) => {
			const listener = () => cb();
			ipcRenderer.on("np:subscriptions:changed", listener);
			return () => ipcRenderer.removeListener("np:subscriptions:changed", listener);
		},
	},
	expandWindow: () => ipcRenderer.send("np:expand-window"),
	onZoom: (cb) => {
		const listener = (_event, factor) => cb(factor);
		ipcRenderer.on("np:zoom", listener);
		return () => ipcRenderer.removeListener("np:zoom", listener);
	},
	getZoom: () => ipcRenderer.invoke("np:zoom:get"),
	pickFolder: (defaultPath) => ipcRenderer.invoke("np:pick-folder", defaultPath),
	onUpdateStatus: (cb) => {
		const listener = (_event, status) => cb(status);
		ipcRenderer.on("np:update-status", listener);
		return () => ipcRenderer.removeListener("np:update-status", listener);
	},
	installUpdate: () => ipcRenderer.send("np:update-install"),
	getUpdateState: () => ipcRenderer.invoke("np:update:get"),
	checkForUpdates: () => ipcRenderer.invoke("np:update:check"),
	onOpenSettings: (cb) => {
		openSettingsListener = cb;
		if (pendingOpenSettings !== null) {
			const section = pendingOpenSettings;
			pendingOpenSettings = null;
			cb(section);
		}
		return () => {
			if (openSettingsListener === cb) openSettingsListener = null;
		};
	},
});
