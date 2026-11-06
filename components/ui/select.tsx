"use client";
/**
 * THE SELECT (design pass, owner 2026-11-06): every dropdown in the app
 * looks and behaves like the model menus — a trigger in the field style,
 * the menu in the shared MenuShell (portaled, viewport-capped, arrow-key
 * cycling with wrap). Owner decision: replaces the native <select>s
 * (syllabus point type, exam context, ChatGPT accounts, inbox folders…).
 *
 * Keyboard: Enter/Space/ArrowDown open; in the menu ↑/↓ cycle, Enter
 * picks, Escape closes WITHOUT bubbling (a dialog under it stays open)
 * and returns focus to the trigger.
 */

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MenuShell } from "@/components/menu-shell";

export interface SelectOption<V extends string = string> {
	value: V;
	label: string;
	disabled?: boolean;
}

const SIZES = {
	// sm = the settings menu-trigger look (SettingsMenuTrigger): every
	// compact dropdown reads like the model menus.
	sm: "h-7 gap-1 rounded-sm px-1.5 text-xs",
	md: "h-9 gap-2 rounded-md px-3 text-sm",
} as const;

export function Select<V extends string = string>({
	value,
	options,
	onChange,
	ariaLabel,
	placeholder,
	disabled,
	size = "md",
	testid,
	className,
	defaultOpen = false,
	onDismiss,
}: {
	value: V | "";
	options: readonly SelectOption<V>[];
	onChange: (next: V) => void;
	ariaLabel: string;
	/** Shown (muted) when no option matches `value`. */
	placeholder?: string;
	disabled?: boolean;
	size?: keyof typeof SIZES;
	testid?: string;
	className?: string;
	/** Mount open (an inline picker that appears on demand). */
	defaultOpen?: boolean;
	/** Called when the menu closes without a pick. */
	onDismiss?: () => void;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const current = options.find((o) => o.value === value);
	const close = (picked: boolean) => {
		setOpen(false);
		triggerRef.current?.focus();
		if (!picked) onDismiss?.();
	};

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (triggerRef.current?.contains(target)) return;
			if ((target as Element).closest?.("[data-np-select-menu]")) return;
			setOpen(false);
			onDismiss?.();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => document.removeEventListener("pointerdown", onPointerDown, true);
	}, [open, onDismiss]);

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				data-testid={testid}
				data-value={value}
				disabled={disabled}
				onClick={() => setOpen((v) => !v)}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" && !open) {
						e.preventDefault();
						setOpen(true);
					}
				}}
				className={cn(
					"inline-flex min-w-0 items-center justify-between border border-border bg-background text-left font-ui text-foreground transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-60",
					SIZES[size],
					className,
				)}
			>
				<span className={cn("min-w-0 truncate", !current && "text-muted-foreground")}>{current?.label ?? placeholder ?? ""}</span>
				<ChevronDownIcon aria-hidden className={cn("shrink-0 text-muted-foreground", size === "sm" ? "size-3" : "size-4")} />
			</button>
			{open && (
				<MenuShell
					anchorRef={triggerRef}
					testid={testid ? `${testid}-menu` : "select-menu"}
					preferredSide="down"
					align="left"
					menuClass="flex min-w-44 max-w-[min(22rem,calc(100vw-1rem))] flex-col rounded-lg border bg-popover p-1 text-sm shadow-float"
				>
					<div
						role="listbox"
						aria-label={ariaLabel}
						data-np-select-menu=""
						className="flex flex-col"
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								e.stopPropagation();
								close(false);
							}
						}}
					>
						{options.map((o) => {
							const selected = o.value === value;
							return (
								<button
									key={o.value}
									type="button"
									role="option"
									aria-selected={selected}
									data-value={o.value}
									disabled={o.disabled}
									onClick={() => {
										close(true);
										if (o.value !== value) onChange(o.value);
									}}
									className={cn(
										"flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-accent focus:bg-accent disabled:opacity-50",
										selected && "font-medium",
									)}
								>
									<span className="min-w-0 flex-1 truncate">{o.label}</span>
									{selected && <CheckIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
								</button>
							);
						})}
					</div>
				</MenuShell>
			)}
		</>
	);
}
