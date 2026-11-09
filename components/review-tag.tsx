"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/i18n";
import { nodeNameMap } from "@/components/node-names";

/**
 * The probe's «Repaso» line (owner, 2026-11-09 — «memoria en el sondeo»):
 * a tagged probe question counts for the learner's memory. Before the
 * answer it reads just «Repaso» — an idea's name can give the answer away;
 * after the verdict, «Repaso: <names>» (names resolved lazily, raw ids
 * when the graph can't be read).
 */
export function ReviewTag({ ids, named }: { ids: readonly string[]; named: boolean }) {
	const t = useT();
	const [names, setNames] = useState<Record<string, string> | null>(null);
	useEffect(() => {
		if (!named || ids.length === 0 || names) return;
		let alive = true;
		void nodeNameMap().then((m) => {
			if (alive) setNames(m);
		});
		return () => {
			alive = false;
		};
	}, [named, ids.length, names]);
	if (ids.length === 0) return null;
	// While the names load, the plain line — never a flash of raw ids.
	const text = named && names
		? t("session.question.reviewTagNamed", { names: ids.map((id) => names[id] ?? id).join(", ") })
		: t("session.question.reviewTag");
	return (
		<div data-testid="review-tag" className="-mt-1 mb-3 text-xs text-muted-foreground">
			{text}
		</div>
	);
}
