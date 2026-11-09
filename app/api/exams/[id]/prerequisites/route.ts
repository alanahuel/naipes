/**
 * «Detectar conocimientos previos» (owner 2026-11-09).
 *   POST   — run the prerequisite finder (202; `prerequisiteSearch` moves
 *            running → ready | error, announced by `exams-changed`). A
 *            draft's results go straight in; an active exam's wait as a
 *            proposal.
 *   PUT    { accept: [itemId] } — apply the checked proposal items.
 *   DELETE — discard the proposal.
 */
import { applyPrerequisiteProposal, startPrerequisiteDetection } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
	const { id } = await params;
	const r = startPrerequisiteDetection(id);
	return r.ok ? Response.json({ ok: true }, { status: 202 }) : Response.json({ error: r.error, ...(r.status === 503 ? { code: "models_not_configured" } : {}) }, { status: r.status });
}

const applied = (r: ReturnType<typeof applyPrerequisiteProposal>) =>
	r.ok ? Response.json({ ok: true, added: r.value.added }) : Response.json({ error: r.error }, { status: r.error === "not_found" ? 404 : 409 });

export async function PUT(request: Request, { params }: Params) {
	const { id } = await params;
	const body = (await request.json().catch(() => null)) as { accept?: unknown } | null;
	const accept = Array.isArray(body?.accept) ? body.accept.filter((x): x is string => typeof x === "string") : null;
	if (!accept) return Response.json({ error: "accept must be a list of ids" }, { status: 400 });
	return applied(applyPrerequisiteProposal(id, { accept }));
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	return applied(applyPrerequisiteProposal(id, { discard: true }));
}
