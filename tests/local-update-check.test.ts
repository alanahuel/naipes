/** Local-build update notices (owner 2026-11-04, Repaso plan stage 0b):
 *  the pure helpers in electron/local-update-check.cjs. No network. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const lu = require("../electron/local-update-check.cjs") as {
	githubRepoFromHomepage(h: unknown): string | null;
	compareVersions(a: string, b: string): number | null;
	isNewer(latest: string, current: string): boolean;
	shouldAnnounce(latest: string, last: string | null): boolean;
	announcementText(version: string, language: string): { title: string; body: string };
	fetchLatestRelease(o: { repo: string; fetchImpl: (url: string, init: unknown) => Promise<unknown>; timeoutMs?: number }): Promise<{ version: string; url: string }>;
};

describe("githubRepoFromHomepage", () => {
	it("reads owner/repo from the package homepage", () => {
		assert.equal(lu.githubRepoFromHomepage("https://github.com/alanahuel/naipes"), "alanahuel/naipes");
		assert.equal(lu.githubRepoFromHomepage("https://github.com/alanahuel/naipes/"), "alanahuel/naipes");
		assert.equal(lu.githubRepoFromHomepage("https://github.com/alanahuel/naipes.git"), "alanahuel/naipes");
	});
	it("rejects anything that is not a GitHub repo url", () => {
		for (const bad of [undefined, "", "http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a", "https://github.com/a/b/c"]) {
			assert.equal(lu.githubRepoFromHomepage(bad), null, String(bad));
		}
	});
});

describe("compareVersions / isNewer", () => {
	it("orders by major, minor, patch, with or without a leading v", () => {
		assert.ok(lu.compareVersions("0.2.0", "0.1.9")! > 0);
		assert.ok(lu.compareVersions("v1.0.0", "0.99.99")! > 0);
		assert.ok(lu.compareVersions("0.1.10", "0.1.9")! > 0);
		assert.equal(lu.compareVersions("v0.1.0", "0.1.0"), 0);
	});
	it("a release outranks its prereleases; prerelease ids follow semver", () => {
		assert.ok(lu.compareVersions("1.0.0", "1.0.0-rc.1")! > 0);
		assert.ok(lu.compareVersions("1.0.0-rc.2", "1.0.0-rc.1")! > 0);
		assert.ok(lu.compareVersions("1.0.0-rc.10", "1.0.0-rc.9")! > 0);
		assert.ok(lu.compareVersions("1.0.0-beta", "1.0.0-alpha")! > 0);
		assert.ok(lu.compareVersions("1.0.0-alpha.1", "1.0.0-alpha")! > 0);
		assert.ok(lu.compareVersions("1.0.0-alpha", "1.0.0-1")! > 0);
	});
	it("garbage never counts as newer", () => {
		assert.equal(lu.compareVersions("latest", "0.1.0"), null);
		assert.equal(lu.isNewer("nightly", "0.1.0"), false);
		assert.equal(lu.isNewer("0.2.0", "dev"), false);
	});
	it("isNewer is strict", () => {
		assert.equal(lu.isNewer("0.1.1", "0.1.0"), true);
		assert.equal(lu.isNewer("0.1.0", "0.1.0"), false);
		assert.equal(lu.isNewer("0.0.9", "0.1.0"), false);
	});
});

describe("shouldAnnounce — once per version", () => {
	it("announces a version only when it differs from the last announced one", () => {
		assert.equal(lu.shouldAnnounce("0.2.0", null), true);
		assert.equal(lu.shouldAnnounce("0.2.0", "0.2.0"), false);
		assert.equal(lu.shouldAnnounce("0.3.0", "0.2.0"), true);
	});
});

describe("announcementText", () => {
	it("speaks Spanish by default and English when asked", () => {
		assert.match(lu.announcementText("0.2.0", "es").title, /0\.2\.0 está disponible/);
		assert.match(lu.announcementText("0.2.0", "whatever").title, /está disponible/);
		assert.match(lu.announcementText("0.2.0", "en").title, /0\.2\.0 is available/);
	});
});

describe("fetchLatestRelease", () => {
	const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });
	it("asks GitHub's releases/latest for the repo and returns version + page", async () => {
		const calls: string[] = [];
		const r = await lu.fetchLatestRelease({
			repo: "alanahuel/naipes",
			fetchImpl: async (url, init) => {
				calls.push(url);
				assert.equal((init as { headers: Record<string, string> }).headers["User-Agent"], "Naipes-update-check");
				return ok({ tag_name: "v0.2.0", html_url: "https://github.com/alanahuel/naipes/releases/tag/v0.2.0" })();
			},
		});
		assert.deepEqual(calls, ["https://api.github.com/repos/alanahuel/naipes/releases/latest"]);
		assert.deepEqual(r, { version: "0.2.0", url: "https://github.com/alanahuel/naipes/releases/tag/v0.2.0" });
	});
	it("falls back to the canonical tag page when html_url is missing or foreign", async () => {
		const r = await lu.fetchLatestRelease({ repo: "a/b", fetchImpl: ok({ tag_name: "v1.2.3", html_url: "https://evil.example/x" }) });
		assert.equal(r.url, "https://github.com/a/b/releases/tag/v1.2.3");
	});
	it("throws on HTTP errors, unusable tags and network failures", async () => {
		await assert.rejects(lu.fetchLatestRelease({ repo: "a/b", fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) }), /HTTP 404/);
		await assert.rejects(lu.fetchLatestRelease({ repo: "a/b", fetchImpl: ok({ tag_name: "nightly" }) }), /tag_name/);
		await assert.rejects(lu.fetchLatestRelease({ repo: "a/b", fetchImpl: async () => { throw new Error("offline"); } }), /offline/);
	});
});
