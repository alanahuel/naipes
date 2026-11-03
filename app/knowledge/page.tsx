import { KnowledgePage } from "@/components/knowledge";
import { readSettingsRecord } from "@/src/server";
import { resolveSettings } from "@/src/core";

export const dynamic = "force-dynamic";

/** Conocimiento: the graph (or the chains view when rendering is off). */
export default function Page() {
	const rendering = resolveSettings(readSettingsRecord() ?? null).graph.rendering;
	return <KnowledgePage rendering={rendering} />;
}
