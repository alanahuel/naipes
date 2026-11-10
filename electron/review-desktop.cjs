/**
 * DESKTOP SIDE OF «REPASO» (owner, 2026-11-04 — stage 2): tray, login
 * autostart and the review notifications' minute clock. Pure helpers here;
 * electron/main.cjs wires Electron (Tray, Notification, login items, fs).
 *
 * The SERVER owns every review rule (POST /api/review/notify decides,
 * records and words a notice); the shell only asks once a minute and shows
 * what it is told. Main-process text (tray menu) carries its two
 * interface languages here — main has no i18n catalog.
 */

"use strict";

/** Launch flag used by the login autostart: start without a window. */
const HIDDEN_FLAG = "--hidden";

/** Marker line so the shell only ever removes ITS OWN autostart entry. */
const AUTOSTART_MARKER = "X-Naipes-Autostart=true";

/** settings.json → the desktop switches + interface language. Absent or
 *  corrupt values keep the factory defaults (tray on, autostart on, es). */
function desktopPrefs(settings) {
	const desktop = settings && typeof settings === "object" ? settings.desktop : undefined;
	const general = settings && typeof settings === "object" ? settings.general : undefined;
	return {
		tray: desktop?.tray !== false,
		autostart: desktop?.autostart !== false,
		language: general?.language === "en" ? "en" : "es",
	};
}

/** Quote one Exec argument per the Desktop Entry spec. */
function desktopExecQuote(arg) {
	return /[\s"'\\$`]/.test(arg) ? `"${arg.replace(/(["`$\\])/g, "\\$1")}"` : arg;
}

/** The XDG autostart entry (~/.config/autostart/naipes.desktop). */
function linuxAutostartEntry(execPath) {
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=Naipes",
		`Exec=${desktopExecQuote(execPath)} ${HIDDEN_FLAG}`,
		"Icon=naipes",
		"Terminal=false",
		"X-GNOME-Autostart-enabled=true",
		AUTOSTART_MARKER,
		"",
	].join("\n");
}

/** Is this file content an autostart entry we wrote? */
function isOwnAutostartEntry(content) {
	return typeof content === "string" && content.includes(AUTOSTART_MARKER);
}

function trayLabels(language, dueCount) {
	const n = Number.isInteger(dueCount) && dueCount > 0 ? dueCount : 0;
	return language === "en"
		? { open: "Open Naipes", review: n > 0 ? `Review now (${n})` : "Review now", quit: "Quit", tooltip: n > 0 ? `Naipes — ${n} to review` : "Naipes" }
		: { open: "Abrir Naipes", review: n > 0 ? `Repasar ahora (${n})` : "Repasar ahora", quit: "Salir", tooltip: n > 0 ? `Naipes — ${n} por repasar` : "Naipes" };
}

/** The renderer paths the shell may navigate to (np:navigate allow-list):
 *  Repaso, the exams list, one exam («Exámenes», 2026-11-05) and the
 *  calendar («Calendario», 2026-11-10). */
const NAVIGABLE_PATHS = new Set(["/review", "/exams", "/calendar"]);
const EXAM_PATH = /^\/exams\/exam_[a-z0-9_]{4,60}$/;

function isNavigablePath(p) {
	return typeof p === "string" && (NAVIGABLE_PATHS.has(p) || EXAM_PATH.test(p));
}

module.exports = {
	HIDDEN_FLAG,
	AUTOSTART_MARKER,
	desktopPrefs,
	desktopExecQuote,
	linuxAutostartEntry,
	isOwnAutostartEntry,
	trayLabels,
	isNavigablePath,
};
