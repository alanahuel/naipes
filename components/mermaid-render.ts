/**
 * The app's ONE mermaid renderer (the chrome-melt wave, 2026-09-19): both the
 * in-chat block (components/md-blocks.tsx) and the session-scoped focus
 * overlay (components/session-overlay.tsx) render charts through this module
 * — one theme-aware config, one plugin instance, unique render ids. This
 * REPLACES streamdown's internal mermaid path entirely: its fullscreen portal
 * was hard-wired `fixed inset-0` (covering the window-drag bar, X landing in
 * drag territory) with no styling hook, which is what drove the custom
 * component in the first place.
 */

import type { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";

/** The chart's base font size (px) — mermaid sizes ALL text relative to
 *  this, so it's the number the display-width cap (md-blocks) divides by:
 *  a chart shown at its natural width renders text at exactly this size.
 *  Pinned explicitly so a mermaid default change can't silently shift the
 *  cap (owner rule, chrome-melt tweaks wave, 2026-09-19: chart text must
 *  never render larger than the session's own text). */
export const MERMAID_FONT_SIZE = 16;

// Diagrams follow the app theme: mermaid's "dark" theme on the dark
// sheet, "neutral" (gray, no color noise) on the light one. Callers pass
// the effective theme and re-render when it changes.
export function mermaidConfig(theme: "light" | "dark"): MermaidConfig {
	return {
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
		fontSize: MERMAID_FONT_SIZE,
		securityLevel: "strict",
		theme: theme === "dark" ? "dark" : "neutral",
	};
}

// LAZY (perf, owner 2026-11-10): mermaid (~600 KB with its plugin) loads
// with the first chart, not with every chat page.
let pluginPromise: Promise<ReturnType<typeof createMermaidPlugin>> | null = null;
const loadPlugin = () => (pluginPromise ??= import("@streamdown/mermaid").then((m) => m.createMermaidPlugin()));

/** Render one chart source to an svg string. The id is unique per call —
 *  mermaid caches rendered ids, and a repeated id across charts/renders
 *  returns the stale svg (the bug streamdown's own id minting avoids). */
export async function renderMermaid(chart: string, theme: "light" | "dark" = "dark"): Promise<string> {
	const id = `np-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const plugin = await loadPlugin();
	const { svg } = await plugin.getMermaid(mermaidConfig(theme)).render(id, chart);
	return svg;
}
