/**
 * «Contrastar con la guía» (owner 2026-11-06).
 *   POST   — find the official guide and compare (202; `contrast` moves
 *            running → ready | error, announced by `exams-changed`).
 *   PUT    { add: [officialPointId], extras: [{ pointId, action: "extension" | "keep" }] }
 *            — apply the chosen differences (added points are researched).
 *   DELETE — discard it.
 */
import { applyExamContrast, startExamContrast } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const reply = (r: ReturnType<typeof startExamContrast>, status = 202) =>
	r.ok ? Response.json({ ok: true }, { status }) : Response.json({ error: r.error, ...(r.status === 503 ? { code: "models_not_configured" } : {}) }, { status: r.status });

export async function POST(_req: Request, { params }: Params) {
	const { id } = await params;
	return reply(startExamContrast(id));
}

export async function PUT(request: Request, { params }: Params) {
	const { id } = await params;
	const body = (await request.json().catch(() => null)) as { add?: unknown; extras?: unknown } | null;
	const add = Array.isArray(body?.add) ? body.add.filter((x): x is string => typeof x === "string") : null;
	const extras = Array.isArray(body?.extras)
		? body.extras
				.filter((e): e is { pointId: string; action: "extension" | "keep" } => e !== null && typeof e === "object" && typeof (e as { pointId?: unknown }).pointId === "string" && ((e as { action?: unknown }).action === "extension" || (e as { action?: unknown }).action === "keep"))
				.map((e) => ({ pointId: e.pointId, action: e.action }))
		: null;
	if (!add || !extras) return Response.json({ error: "add and extras must be lists" }, { status: 400 });
	return reply(applyExamContrast(id, { add, extras }), 200);
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	return reply(applyExamContrast(id, { discard: true }), 200);
}
