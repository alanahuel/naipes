/**
 * THE THEME (Naipes interface, 2026-11-03): light and dark, chosen in
 * Appearance as "system" | "light" | "dark". Pure — shared by the client
 * provider (components/settings/appearance.tsx) and the server-rendered
 * root layout, which puts the forced mode's class on <html> so the first
 * paint is already right; "system" renders no class and the
 * prefers-color-scheme media query in app/globals.css decides.
 */
import type { ThemeMode } from "./settings.ts";

/** The theme actually shown. */
export type EffectiveTheme = "light" | "dark";

/** The chosen mode + the OS preference → the theme shown. */
export function effectiveTheme(mode: ThemeMode, systemDark: boolean): EffectiveTheme {
	if (mode === "system") return systemDark ? "dark" : "light";
	return mode;
}

/** The <html> class the server renders for a mode ("" for system). */
export function themeClassFor(mode: ThemeMode): "" | "light" | "dark" {
	return mode === "system" ? "" : mode;
}
