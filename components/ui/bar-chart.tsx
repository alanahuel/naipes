"use client";
/**
 * THE BAR CHART (design pass, owner 2026-11-06): one component for every
 * per-day column chart — Repaso's forecast and an exam's 14-day plan used
 * to be two diverging copies. Owner decisions: «Hoy» capitalized and
 * emphasized on the axis; values only on hover / focus / tap (no fixed
 * numbers over the bars). ≤24px columns, 4px rounded tops, square at the
 * baseline, 2px air; the sr-only table carries every value.
 */

import { useState } from "react";
import { cn } from "@/lib/utils";

export function BarChart({
	values,
	axisLabel,
	barLabel,
	caption,
	height = "h-36",
	testid,
}: {
	values: readonly number[];
	/** The short axis label under column i ("" = none). */
	axisLabel: (i: number) => string;
	/** The full sentence for column i — tooltip, aria-label and table row. */
	barLabel: (i: number) => string;
	caption: string;
	height?: string;
	testid?: string;
}) {
	const [active, setActive] = useState<number | null>(null);
	const max = Math.max(1, ...values);
	const pctOf = (n: number) => (n / max) * 100;
	return (
		<div className="px-1">
			<div className={cn("relative flex items-end gap-0.5 border-b border-border pt-8", height)} data-testid={testid}>
				{values.map((n, i) => (
					<div
						key={i}
						role="img"
						tabIndex={0}
						aria-label={barLabel(i)}
						onPointerEnter={() => setActive(i)}
						onPointerLeave={() => setActive((h) => (h === i ? null : h))}
						onPointerDown={() => setActive((h) => (h === i ? null : i))}
						onFocus={() => setActive(i)}
						onBlur={() => setActive((h) => (h === i ? null : h))}
						className="relative flex h-full flex-1 items-end justify-center outline-none"
					>
						<span
							className={cn("w-full max-w-6 rounded-t-sm bg-np-data transition-opacity", active !== null && active !== i && "opacity-50")}
							style={{ height: n > 0 ? `${Math.max(2, pctOf(n))}%` : 0 }}
						/>
						{active === i && (
							<span
								className={cn(
									"pointer-events-none absolute z-10 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs shadow-float",
									i < values.length / 3 ? "left-0" : i >= (values.length * 2) / 3 ? "right-0" : "left-1/2 -translate-x-1/2",
								)}
								style={{ bottom: `calc(${pctOf(n)}% + 6px)` }}
							>
								{barLabel(i)}
							</span>
						)}
					</div>
				))}
			</div>
			<div className="mt-1.5 flex gap-0.5 text-2xs text-muted-foreground" aria-hidden>
				{values.map((_, i) => (
					<span key={i} className={cn("flex-1 text-center tabular-nums", i === 0 && "font-semibold text-foreground")}>
						{axisLabel(i)}
					</span>
				))}
			</div>
			<table className="sr-only">
				<caption>{caption}</caption>
				<tbody>
					{values.map((_, i) => (
						<tr key={i}>
							<td>{barLabel(i)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
