import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { CONFIDENCE_STOPS } from "@/src/core";

/**
 * The confidence RAIL — the slider's paint, shared by two surfaces so they
 * can never drift apart (owner, 2026-10-01):
 *
 *   - the dock's live slider (question-dock) — a transparent range input
 *     rides on top of this paint, disc and all;
 *   - the ANSWERED card (owner round 6) — the same rail with NO disc,
 *     which itself communicates "this is a record, not a control".
 *
 * Geometry law: the rail spans the thumb-CENTER range (inset half a 16px
 * disc per side) so the dock's 0/100 stops sit flush at the very ends.
 * The static card has no thumb, but keeps the identical shape.
 *
 * Stack law: the muted surface as base, SOLID stop ticks
 * as background layers UNDER the fill, and the fill itself TRANSPARENT
 * past the value — so ticks show only on the empty side, never over the
 * color. Ticks skip 0 and 100 (the rail's ends already say those).
 */

/** The six-step ramp (owner ruling): 0 red → 100 emerald, indexed by stop. */
export const CONFIDENCE_COLORS: readonly string[] = [
	"#ef4444", // 0
	"#f97316", // 30
	"#eab308", // 50
	"#84cc16", // 70
	"#22c55e", // 90
	"#10b981", // 100
];

/** The rail's paint for a stop value (0–100); null = not chosen yet (owner
 *  2026-11-09: never pre-filled) — the bare rail, ticks only. */
export function confidenceRailStyle(chosen: number | null): CSSProperties {
	const value = chosen ?? 0;
	const color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(value)] ?? CONFIDENCE_COLORS[2]!;
	return {
		backgroundColor: "var(--muted)",
		backgroundImage: [
			`linear-gradient(90deg, ${color} 0%, ${color} ${value}%, transparent ${value}%, transparent 100%)`,
			...[30, 50, 70, 90].map(
				() => "linear-gradient(90deg, color-mix(in oklab, var(--foreground) 35%, transparent), color-mix(in oklab, var(--foreground) 35%, transparent))",
			),
		].join(", "),
		backgroundSize: ["100% 100%", "1px 100%", "1px 100%", "1px 100%", "1px 100%"].join(", "),
		backgroundPosition: ["0 0", ...[30, 50, 70, 90].map((p) => `${p}% 0`)].join(", "),
		backgroundRepeat: "no-repeat",
	};
}

/** The static rail — the slider's look, disc removed. */
export function ConfidenceRail({ value, className }: { value: number; className?: string }) {
	return (
		<div
			aria-hidden
			data-testid="confidence-rail"
			className={cn("h-1.5 w-full rounded-full border border-border", className)}
			style={confidenceRailStyle(value)}
		/>
	);
}

/** The stop index nearest a raw 0–100 slider position. */
export function nearestConfidenceIndex(v: number): number {
	let best = 0;
	for (let i = 1; i < CONFIDENCE_STOPS.length; i++) {
		if (Math.abs(CONFIDENCE_STOPS[i]! - v) < Math.abs(CONFIDENCE_STOPS[best]! - v)) best = i;
	}
	return best;
}

/** ←/→ from a stop index; from «not chosen» either key lands on the middle
 *  stop (50) — a deliberate pick from there on. */
export function stepConfidenceIndex(index: number | null, dir: 1 | -1): number {
	if (index === null) return Math.floor((CONFIDENCE_STOPS.length - 1) / 2);
	return Math.min(CONFIDENCE_STOPS.length - 1, Math.max(0, index + dir));
}

/** Classes for the transparent range input riding on the rail; the disc
 *  hides while nothing is chosen. */
export const confidenceInputClass = (chosen: boolean) =>
	cn(
		"absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent outline-none",
		"[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent",
		"[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current",
		"[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent",
		"[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-current",
		!chosen && "[&::-webkit-slider-thumb]:opacity-0 [&::-moz-range-thumb]:opacity-0",
	);

/**
 * The confidence SLIDER (practice dock, «Exámenes» 2026-11-05): the quiz
 * dock's snapped control as a standalone piece — same rail, same stops,
 * same ramp colors. Native range keys (focused ←/→) move it a stop.
 * Never pre-filled (owner 2026-11-09): `value` null = not chosen yet;
 * `missing` flags a blocked send («Elige tu seguridad»).
 */
export function ConfidenceSlider({
	value,
	onChange,
	label,
	missingLabel,
	missing = false,
	ariaLabel,
	valueText,
	testid = "practice-confidence",
}: {
	/** Stop value (0, 30, 50, 70, 90, 100), or null = not chosen. */
	value: number | null;
	onChange: (stop: number) => void;
	label: string;
	missingLabel: string;
	missing?: boolean;
	ariaLabel: string;
	valueText: string;
	testid?: string;
}) {
	const index = value === null ? null : Math.max(0, CONFIDENCE_STOPS.indexOf(value));
	const pick = (raw: number) => onChange(CONFIDENCE_STOPS[nearestConfidenceIndex(raw)]!);
	return (
		<div className="flex items-center gap-3" data-testid={testid} data-chosen={value !== null} data-missing={missing}>
			<span className={cn("shrink-0 text-xs font-medium", missing ? "text-warn" : "text-muted-foreground")}>{missing ? missingLabel : label}</span>
			<div className={cn("relative h-4 min-w-0 flex-1 rounded-full", missing && "ring-2 ring-warn/60")}>
				<div aria-hidden className="pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full border border-border" style={confidenceRailStyle(value)} />
				<input
					type="range"
					min={0}
					max={100}
					step={1}
					value={value ?? 50}
					aria-label={ariaLabel}
					aria-valuetext={valueText}
					onKeyDown={(e) => {
						if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
						e.preventDefault();
						e.stopPropagation();
						onChange(CONFIDENCE_STOPS[stepConfidenceIndex(index, e.key === "ArrowRight" ? 1 : -1)]!);
					}}
					onChange={(e) => pick(Number(e.target.value))}
					// A click on the hidden disc's own spot fires no change.
					onPointerUp={(e) => {
						if (value === null) pick(Number((e.target as HTMLInputElement).value));
					}}
					style={{ color: CONFIDENCE_COLORS[index ?? 2] }}
					className={confidenceInputClass(value !== null)}
				/>
			</div>
			<span className="w-9 shrink-0 text-right font-mono text-sm tabular-nums">{value === null ? "—" : `${value}%`}</span>
		</div>
	);
}
