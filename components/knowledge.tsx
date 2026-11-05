"use client";
/**
 * CONOCIMIENTO (Naipes interface, stage 3): the knowledge graph in its own
 * tab, filling the sheet — or, with graph rendering off, the quiet
 * summary + chains view. Picking ideas for practice now happens from
 * Inicio (its own chain table), so this tab carries no composer.
 */
import { GraphView } from "@/components/graph-view";
import { MinimalHome } from "@/components/minimal-home";
import { InboxCard } from "@/components/inbox-card";

export function KnowledgePage({ rendering = true }: { rendering?: boolean }) {
	return (
		<div className="relative h-full" data-testid="knowledge-page">
			<div className="absolute inset-0">{rendering ? <GraphView /> : <MinimalHome />}</div>
			<InboxCard />
		</div>
	);
}
