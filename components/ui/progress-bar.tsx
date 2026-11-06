/**
 * THE PROGRESS BAR (design pass, owner 2026-11-06): a NEUTRAL track (the
 * old light-blue track read as "filled" at 0%), the data hue for the fill,
 * a hairline tick at the target. Owner decision: in the detail views the
 * tick carries its label («70%») so the line explains itself; lists keep
 * the bare tick (their text line names the target).
 */

import { cn } from "@/lib/utils";

export function ProgressBar({
	value,
	target,
	label,
	showTargetLabel = false,
	className,
}: {
	/** 0–100. */
	value: number;
	/** 0–100; omitted = no tick. */
	target?: number;
	/** Accessible description of the whole bar; omitted = decorative
	 *  (the row around it already speaks). */
	label?: string;
	showTargetLabel?: boolean;
	className?: string;
}) {
	const v = Math.max(0, Math.min(100, value));
	return (
		<span className={cn("relative block", showTargetLabel && target !== undefined && "pt-5", className)} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
			<span className="relative block h-2 rounded-full bg-foreground/10">
				<span className="absolute inset-y-0 left-0 rounded-full bg-np-data" style={{ width: `${v}%` }} />
				{target !== undefined && <span className="absolute -inset-y-1 w-px bg-foreground/70" style={{ left: `${target}%` }} />}
			</span>
			{showTargetLabel && target !== undefined && (
				<span
					aria-hidden
					className="absolute top-0 -translate-x-1/2 text-2xs font-medium tabular-nums text-muted-foreground"
					style={{ left: `clamp(1rem, ${target}%, calc(100% - 1rem))` }}
				>
					{target}%
				</span>
			)}
		</span>
	);
}
