import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { effectiveTheme, themeClassFor } from "../src/core/theme.ts";
import { isThemeMode, sanitizeUserSettings } from "../src/core/settings.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";

describe("theme mode", () => {
	it("system follows the OS; light/dark force", () => {
		assert.equal(effectiveTheme("system", true), "dark");
		assert.equal(effectiveTheme("system", false), "light");
		assert.equal(effectiveTheme("light", true), "light");
		assert.equal(effectiveTheme("dark", false), "dark");
	});

	it("accepts only system/light/dark on read and write", () => {
		assert.ok(isThemeMode("system") && isThemeMode("light") && isThemeMode("dark"));
		assert.ok(!isThemeMode("auto"));
		assert.equal(sanitizeUserSettings({ version: 1, appearance: { mode: "light" } })?.appearance?.mode, "light");
		assert.equal(sanitizeUserSettings({ version: 1, appearance: { mode: "auto" } })?.appearance?.mode, undefined);
		assert.equal(parseAppearanceSettingsBody({ mode: "system" }).ok, true);
		assert.equal(parseAppearanceSettingsBody({ mode: "auto" }).ok, false);
	});

	it("the server renders a class only for a forced mode (system = the CSS media query)", () => {
		assert.equal(themeClassFor("system"), "");
		assert.equal(themeClassFor("light"), "light");
		assert.equal(themeClassFor("dark"), "dark");
	});

	it("globals.css carries the dark tokens for .dark AND for system-dark without .light", () => {
		const css = readFileSync("app/globals.css", "utf-8");
		assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\.light\) \{/);
		const block = (start: string) => css.slice(css.indexOf(start)).split("}")[0]!;
		const forced = block(".dark {").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("--")).join("\n");
		const system = block(":root:not(.light) {").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("--")).join("\n");
		assert.ok(forced.length > 0);
		assert.equal(system, forced, "the two dark blocks must stay identical");
	});
});
