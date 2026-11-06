/**
 * THE LIST CARD (design pass, owner 2026-11-06): a bordered card of rows,
 * each row = title (one line, truncated, full text in the tooltip) over a
 * quiet meta line, with an optional action at the right that NEVER wraps
 * or shrinks. Owner decision for «Hoy para tu examen»: two lines, the
 * useful numbers (minutes, days left) on their own line where the
 * truncation can't eat them.
 */

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function ListCard({ children, as = "ul", className, testid }: { children: React.ReactNode; as?: "ul" | "ol" | "div"; className?: string; testid?: string }) {
	const Tag = as;
	return (
		<Tag className={cn("overflow-hidden rounded-xl border", className)} data-testid={testid}>
			{children}
		</Tag>
	);
}

export function ListRow({
	title,
	meta,
	action,
	href,
	leading,
	testid,
	titleTestid,
	className,
}: {
	title: React.ReactNode;
	meta?: React.ReactNode;
	action?: React.ReactNode;
	/** The title links here (the row's action stays a separate control). */
	href?: string;
	leading?: React.ReactNode;
	testid?: string;
	titleTestid?: string;
	className?: string;
}) {
	const tooltip = typeof title === "string" ? title : undefined;
	const titleEl = href ? (
		<Link href={href} className="block truncate text-sm font-medium hover:underline" title={tooltip} data-testid={titleTestid}>
			{title}
		</Link>
	) : (
		<span className="block truncate text-sm font-medium" title={tooltip} data-testid={titleTestid}>
			{title}
		</span>
	);
	return (
		<li className={cn("flex min-h-14 items-center gap-3 border-b px-4 py-2.5 last:border-b-0", className)} data-testid={testid}>
			{leading}
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				{titleEl}
				{meta && <div className="truncate text-xs text-muted-foreground">{meta}</div>}
			</div>
			{action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
		</li>
	);
}
