/**
 * check-onboarding.ts — the onboarding release gate (owner, 2026-11-09).
 *
 * Fails when the commits since the previous release tag include a `feat:`
 * and the onboarding registry (src/core/onboarding.ts) has no entry for
 * package.json's version. A version with nothing to announce adds a
 * `silent: true` entry — the explicit «sin novedades».
 *
 * Runs first in the release workflow's quality job and locally before
 * tagging: `pnpm check:onboarding`. Needs the tags (CI: fetch-depth 0).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { hasOnboardingEntryFor } from "../src/core/onboarding.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

const { version } = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };

let previous: string | null = null;
try {
	previous = git("describe", "--tags", "--abbrev=0", "--match", "v*", "--exclude", `v${version}`, "HEAD");
} catch {
	previous = null; // no earlier release tag
}

const subjects = git("log", "--format=%s", previous ? `${previous}..HEAD` : "HEAD").split("\n").filter(Boolean);
const features = subjects.filter((s) => /^feat(\([^)]*\))?!?:/.test(s));

if (hasOnboardingEntryFor(version)) {
	console.log(`onboarding: entry for ${version} found (${features.length} feat commit(s) since ${previous ?? "the start"}).`);
} else if (features.length === 0) {
	console.log(`onboarding: no feat commits since ${previous ?? "the start"} — no entry needed for ${version}.`);
} else {
	console.error(`onboarding: ${version} has ${features.length} feat commit(s) since ${previous ?? "the start"} but no entry in src/core/onboarding.ts:`);
	for (const f of features) console.error(`  - ${f}`);
	console.error(`Add its Novedades (or a { silent: true } entry for «sin novedades») with version "${version}".`);
	process.exit(1);
}
