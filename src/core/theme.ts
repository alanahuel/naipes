/**
 * THE THEME (Naipes interface, 2026-11-03): light and dark, chosen in
 * Appearance as "system" | "light" | "dark". Pure — shared by the client
 * provider (components/settings/appearance.tsx) and the server-rendered
 * root layout, which inlines THEME_BOOT_SCRIPT so the cached mode applies
 * before first paint (no dark→light flash).
 */
import type { ThemeMode } from "./settings.ts";

/** localStorage key for the chosen mode (read by the pre-paint script). */
export const THEME_STORAGE_KEY = "np:theme-mode";

/** The theme actually shown. */
export type EffectiveTheme = "light" | "dark";

/** The chosen mode + the OS preference → the theme shown. */
export function effectiveTheme(mode: ThemeMode, systemDark: boolean): EffectiveTheme {
	if (mode === "system") return systemDark ? "dark" : "light";
	return mode;
}

/** Inline <head> script: applies the cached mode before React hydrates. */
export const THEME_BOOT_SCRIPT = `(function(){try{var m=localStorage.getItem("${THEME_STORAGE_KEY}");var d=m==="dark"||(m!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";r.dataset.theme=d?"dark":"light";}catch(e){}})();`;
