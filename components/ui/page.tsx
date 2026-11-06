/**
 * THE PAGE SKELETON (design pass, owner 2026-11-06): one column, one
 * header, one section title — so every tab (Repaso, Exámenes, Mis
 * sesiones…) lines up to the pixel. Before this each page carried its own
 * copy of the header classes and they had drifted (the sessions title sat
 * 4px left of the rest).
 *
 * Owner decision: long titles wrap to TWO lines and clamp from the third,
 * the full text in the native tooltip; the actions stay top-aligned with
 * the first line.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

/** The scrolling page body: centered column, the shared gutters and rhythm. */
export function Page({ children, testid, className }: { children: React.ReactNode; testid?: string; className?: string }) {
	return (
		<div className="h-full overflow-y-auto" data-testid={testid}>
			<div className={cn("mx-auto flex w-full max-w-[46rem] flex-col gap-10 px-4 pb-16 pt-8 sm:pt-10", className)}>{children}</div>
		</div>
	);
}

export function PageHeader({
	title,
	subtitle,
	back,
	actions,
	titleTestid,
}: {
	title: React.ReactNode;
	subtitle?: React.ReactNode;
	/** A back link rendered above the title («← Exámenes»). */
	back?: React.ReactNode;
	actions?: React.ReactNode;
	titleTestid?: string;
}) {
	return (
		<header className="flex flex-col gap-1 px-1">
			{back && <div className="text-sm text-muted-foreground">{back}</div>}
			<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
				<div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
					<h1
						className="line-clamp-2 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]"
						title={typeof title === "string" ? title : undefined}
						data-testid={titleTestid}
					>
						{title}
					</h1>
					{subtitle && <div className="text-sm text-muted-foreground">{subtitle}</div>}
				</div>
				{actions && <div className="flex shrink-0 items-center gap-2 sm:min-h-[34px]">{actions}</div>}
			</div>
		</header>
	);
}

/** A page section: title row (+ optional right-hand control) and body. */
export function Section({
	title,
	right,
	children,
	testid,
	className,
}: {
	title?: React.ReactNode;
	right?: React.ReactNode;
	children?: React.ReactNode;
	testid?: string;
	className?: string;
}) {
	return (
		<section className={cn("flex flex-col gap-3", className)} data-testid={testid}>
			{title !== undefined && <SectionTitle right={right}>{title}</SectionTitle>}
			{children}
		</section>
	);
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
	return (
		<div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1">
			<h2 className="min-w-0 text-lg font-semibold">{children}</h2>
			{right}
		</div>
	);
}
