/** The desktop side of «Repaso» (stage 2): electron/review-desktop.cjs. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const rd = require("../electron/review-desktop.cjs") as {
	HIDDEN_FLAG: string;
	desktopPrefs(s: unknown): { tray: boolean; autostart: boolean; language: string };
	linuxAutostartEntry(exec: string): string;
	isOwnAutostartEntry(c: unknown): boolean;
	trayLabels(language: string, n: number): { open: string; review: string; quit: string; tooltip: string };
	isNavigablePath(p: unknown): boolean;
};

describe("review desktop helpers", () => {
	it("prefs: factory on, explicit false off, English only when chosen", () => {
		assert.deepEqual(rd.desktopPrefs(null), { tray: true, autostart: true, language: "es" });
		assert.deepEqual(rd.desktopPrefs({ desktop: { tray: false, autostart: "no" }, general: { language: "en" } }), { tray: false, autostart: true, language: "en" });
	});
	it("the XDG entry launches hidden, quotes paths with spaces, and is recognizably ours", () => {
		const entry = rd.linuxAutostartEntry("/home/a b/Naipes.AppImage");
		assert.match(entry, /^Exec="\/home\/a b\/Naipes.AppImage" --hidden$/m);
		assert.match(entry, /^\[Desktop Entry\]$/m);
		assert.equal(rd.isOwnAutostartEntry(entry), true);
		assert.equal(rd.isOwnAutostartEntry("[Desktop Entry]\nExec=other\n"), false);
		assert.equal(rd.isOwnAutostartEntry(null), false);
	});
	it("tray labels carry the due count", () => {
		assert.equal(rd.trayLabels("es", 12).review, "Repasar ahora (12)");
		assert.equal(rd.trayLabels("es", 0).review, "Repasar ahora");
		assert.equal(rd.trayLabels("en", 3).review, "Review now (3)");
		assert.equal(rd.trayLabels("es", 0).quit, "Salir");
	});
	it("only allow-listed paths navigate", () => {
		assert.equal(rd.isNavigablePath("/review"), true);
		assert.equal(rd.isNavigablePath("/exams"), true);
		assert.equal(rd.isNavigablePath("/exams/exam_abc123_d4e5f6a7"), true);
		for (const bad of ["/settings", "https://x", "//evil", undefined, "/review/../x", "/exams/../settings", "/exams/exam_X"]) assert.equal(rd.isNavigablePath(bad), false);
	});
});
