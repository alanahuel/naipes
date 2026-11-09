"use client";
/**
 * THE PAGER (owner 2026-11-09, first use: the exam page's long lists):
 * «‹ Anterior · 2 de 4 · Siguiente ›» under a list. Nothing renders for a
 * single page. The ends disable their button rather than hide it, so the
 * row never shifts under the pointer.
 */

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { useT } from "@/components/i18n";

/** A paged list's state as its owner hands it down: the page (from the
 *  URL on the exam page) and the setter that writes it back. */
export interface Paging {
	page: number;
	onPage: (next: number) => void;
}

export function Pager({ page, pages, onPage, testid }: { page: number; pages: number; onPage: (next: number) => void; testid?: string }) {
	const t = useT();
	if (pages <= 1) return null;
	const btn = cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-muted-foreground");
	return (
		<nav aria-label={t("common.pager.label")} className="flex items-center justify-center gap-2" data-testid={testid}>
			<button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)} data-testid="pager-prev">
				<ChevronLeftIcon />
				{t("common.pager.prev")}
			</button>
			<span className="min-w-16 text-center text-sm tabular-nums text-muted-foreground" aria-live="polite" data-testid="pager-status">
				{t("common.pager.status", { page, pages })}
			</span>
			<button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)} data-testid="pager-next">
				{t("common.pager.next")}
				<ChevronRightIcon />
			</button>
		</nav>
	);
}
