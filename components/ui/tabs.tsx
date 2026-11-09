"use client";
/**
 * THE TABS (owner 2026-11-09, first use: the exam page): Radix Tabs —
 * roving focus, ←/→ move between tabs, Home/End, the tab/tabpanel ARIA
 * wiring — styled as an underlined row. Controlled only: the page owns
 * the open tab (the exam page keeps it in the URL).
 *
 * Narrow windows: the row scrolls sideways instead of wrapping; the open
 * tab is kept in view when it changes and when the row resizes.
 *
 * A tab can carry a dot (`alert`): a small primary mark plus a sr-only
 * label, for «something here wants you».
 */

import * as React from "react";
import { Tabs as RadixTabs } from "radix-ui";
import { cn } from "@/lib/utils";

export interface TabItem<V extends string = string> {
	value: V;
	label: string;
	alert?: boolean;
	testid?: string;
}

export function Tabs<V extends string>({
	value,
	onChange,
	items,
	label,
	alertLabel,
	children,
	className,
}: {
	value: V;
	onChange: (next: V) => void;
	items: readonly TabItem<V>[];
	/** The tablist's accessible name. */
	label: string;
	/** sr-only text after a tab that carries a dot. */
	alertLabel: string;
	/** The panels (TabPanel). */
	children: React.ReactNode;
	className?: string;
}) {
	const listRef = React.useRef<HTMLDivElement | null>(null);
	// Keep the open tab visible in a row narrower than its tabs — on change
	// and on resize — scrolling the row only (never the page).
	React.useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const reveal = () => {
			const tab = list.querySelector<HTMLElement>("[data-state=active]");
			if (!tab) return;
			const left = tab.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
			if (left < list.scrollLeft) list.scrollLeft = left;
			else if (left + tab.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = left + tab.offsetWidth - list.clientWidth;
		};
		reveal();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
		observer?.observe(list);
		return () => observer?.disconnect();
	}, [value]);
	return (
		<RadixTabs.Root value={value} onValueChange={(v) => onChange(v as V)} activationMode="automatic" className={cn("flex flex-col gap-8", className)}>
			{/* The app-wide thin scrollbar (globals.css, unlayered) beats any
			    utility class, so the row hides its own with an inline style;
			    overflow-y hidden + the underline as an inset shadow = nothing
			    overflows vertically (no 1px scroll, no stray bar). */}
			<RadixTabs.List
				ref={listRef}
				aria-label={label}
				style={{ scrollbarWidth: "none" }}
				className="flex overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-border)] [&::-webkit-scrollbar]:hidden"
			>
				{items.map((item) => (
					<RadixTabs.Trigger
						key={item.value}
						value={item.value}
						data-testid={item.testid}
						className={cn(
							"relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-sm first:pl-1 text-muted-foreground transition-colors",
							"hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
							"data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_-2px_0_var(--color-primary)]",
						)}
					>
						{item.label}
						{item.alert && (
							<>
								<span aria-hidden className="size-1.5 rounded-full bg-primary" data-testid="tab-alert" />
								<span className="sr-only">{alertLabel}</span>
							</>
						)}
					</RadixTabs.Trigger>
				))}
			</RadixTabs.List>
			{children}
		</RadixTabs.Root>
	);
}

export function TabPanel({ value, children, testid }: { value: string; children: React.ReactNode; testid?: string }) {
	return (
		<RadixTabs.Content value={value} data-testid={testid} className="flex flex-col gap-10 focus-visible:outline-none">
			{children}
		</RadixTabs.Content>
	);
}
