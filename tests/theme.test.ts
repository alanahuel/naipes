import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { THEME_BOOT_SCRIPT, THEME_STORAGE_KEY, effectiveTheme } from "../src/core/theme.ts";
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

	for (const [stored, systemDark, expected] of [
		["dark", false, true],
		["light", true, false],
		["system", true, true],
		[null, false, false],
	] as const) {
		it(`boot script: stored=${stored} systemDark=${systemDark} → dark=${expected}`, () => {
			const classes = new Set<string>();
			const root = {
				classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) },
				style: {} as Record<string, string>,
				dataset: {} as Record<string, string>,
			};
			runInNewContext(THEME_BOOT_SCRIPT, {
				localStorage: { getItem: (key: string) => (key === THEME_STORAGE_KEY ? stored : null) },
				window: { matchMedia: () => ({ matches: systemDark }) },
				document: { documentElement: root },
			});
			assert.equal(classes.has("dark"), expected);
			assert.equal(root.style.colorScheme, expected ? "dark" : "light");
		});
	}
});
