/**
 * POST /api/chats/:id/vault-summary — the «Resumir» button: one model call
 * (the extractor's model) writes a prose summary of the session into the
 * Obsidian vault (Sesiones/). Errors map to the outcome's status; the
 * models/key refusals carry their usual envelopes.
 */
import { summarizeChatToVault } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	try {
		const outcome = await summarizeChatToVault(id);
		if (outcome.ok) return Response.json({ file: outcome.file });
		const { status, ...body } = outcome;
		return Response.json(body, { status });
	} catch (err) {
		console.error(`[vault] summary for ${id} failed:`, err);
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
}
