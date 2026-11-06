/**
 * LOCAL-BUILD UPDATE NOTICES (owner, 2026-11-04 — Repaso plan, stage 0b).
 *
 * A copy built from a checkout (scripts/install-linux.sh → npLocalBuild)
 * carries the owner's own changes, so electron-updater must never replace
 * it. Instead it only ASKS GitHub whether a newer release exists and says
 * so — once per version — never downloading or installing anything.
 * Since 2026-11-06 (distribution plan) the same notice-only mode also covers
 * macOS (unsigned: Squirrel.Mac can't install) and AUR installs (pacman owns
 * the files) — see noticeKind.
 *
 * Pure helpers; electron/main.cjs wires them (fetch, files, notifications).
 * Everything that can fail returns or throws plainly — main.cjs turns any
 * failure into a log line and a generic "error" status.
 */

"use strict";

const RELEASE_TIMEOUT_MS = 15_000;

/** "https://github.com/owner/repo" → "owner/repo"; anything else → null. */
function githubRepoFromHomepage(homepage) {
	if (typeof homepage !== "string") return null;
	const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(homepage.trim());
	return m ? `${m[1]}/${m[2]}` : null;
}

/** Parse "v1.2.3" / "1.2.3-beta.1" → { core: [1,2,3], pre: ["beta", 1] }, or null. */
function parseVersion(text) {
	if (typeof text !== "string") return null;
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
	if (!m) return null;
	const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
	return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** Semver precedence: <0 when a<b, 0 equal, >0 when a>b. Unparseable → null. */
function compareVersions(a, b) {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
	// A release outranks its own prereleases (1.0.0 > 1.0.0-rc.1).
	if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		if (p === q) continue;
		if (typeof p === "number" && typeof q === "number") return p - q;
		if (typeof p === "number") return -1; // numeric identifiers sort first
		if (typeof q === "number") return 1;
		return p < q ? -1 : 1;
	}
	return 0;
}

/** The latest PUBLISHED release (GitHub's releases/latest skips drafts and
 *  prereleases): { version, url }. Throws on network/HTTP/shape failure.
 *  `fetchImpl` is injected — main passes its global fetch, tests a fake. */
async function fetchLatestRelease({ repo, fetchImpl, timeoutMs = RELEASE_TIMEOUT_MS }) {
	const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { Accept: "application/vnd.github+json", "User-Agent": "Naipes-update-check" },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`GitHub releases/latest → HTTP ${res.status}`);
	const body = await res.json();
	const version = typeof body?.tag_name === "string" ? body.tag_name.replace(/^v/, "") : null;
	if (!version || !parseVersion(version)) throw new Error("GitHub releases/latest: no usable tag_name");
	const url = typeof body.html_url === "string" && body.html_url.startsWith("https://github.com/")
		? body.html_url
		: `https://github.com/${repo}/releases/tag/v${version}`;
	return { version, url };
}

/** Newer than what runs? (unparseable on either side → false: never nag
 *  on garbage). */
function isNewer(latest, current) {
	const c = compareVersions(latest, current);
	return c !== null && c > 0;
}

/** The OS notification fires once per version: only when `latest` differs
 *  from the version last announced. */
function shouldAnnounce(latest, lastAnnounced) {
	return typeof latest === "string" && latest !== lastAnnounced;
}

/** Which copies only ANNOUNCE new releases instead of installing them
 *  (owner 2026-11-06, distribution plan), most specific first:
 *   - "local":  built from a checkout (npLocalBuild) — the owner's changes;
 *   - "pacman": installed by the AUR package (resources/package-type =
 *               "pacman") — pacman owns the files, so it updates them;
 *   - "mac":    macOS — unsigned, and Squirrel.Mac installs signed apps only.
 *  null → electron-updater downloads and installs (Windows, AppImage, deb). */
function noticeKind({ localBuild, packageType, platform }) {
	if (localBuild === true) return "local";
	if (platform === "linux" && typeof packageType === "string" && packageType.trim() === "pacman") return "pacman";
	if (platform === "darwin") return "mac";
	return null;
}

/** The desktop notification text — main has no i18n catalog, so the two
 *  interface languages live here (settings general.language; es default). */
function announcementText(version, language, kind = "local") {
	const en = language === "en";
	const title = en ? `Naipes ${version} is available` : `Naipes ${version} está disponible`;
	if (kind === "pacman") {
		return { title, body: en
			? "Update it with your package manager (e.g. paru -Syu)."
			: "Actualízala con tu gestor de paquetes (p. ej. paru -Syu)." };
	}
	if (kind === "mac") {
		return { title, body: en
			? "Click to download it from the release page."
			: "Pulsa para descargarla desde la página de la versión." };
	}
	return { title, body: en
		? "Your copy is a local build: update it with git pull and scripts/install-linux.sh. Click to see what's new."
		: "Tu copia es local: actualízala con git pull y scripts/install-linux.sh. Pulsa para ver las novedades." };
}

module.exports = {
	RELEASE_TIMEOUT_MS,
	githubRepoFromHomepage,
	parseVersion,
	compareVersions,
	fetchLatestRelease,
	isNewer,
	shouldAnnounce,
	noticeKind,
	announcementText,
};
