/**
 * POST /api/exams/[id]/guide — while the mapping waits for the official
 * guide (owner 2026-11-06): { action: "retry" } searches again (after the
 * learner pasted, attached or linked it as a material); { action: "skip" }
 * goes on without one («Seguir sin guía»). 202, then `mapping` moves on.
 */
import { resolveMissingGuide } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
	if (body?.action !== "retry" && body?.action !== "skip") return Response.json({ error: "action must be retry or skip" }, { status: 400 });
	const started = resolveMissingGuide(id, body.action);
	if (!started.ok) return Response.json({ error: started.error, ...(started.status === 503 ? { code: "models_not_configured" } : {}) }, { status: started.status });
	return Response.json({ ok: true }, { status: 202 });
}
