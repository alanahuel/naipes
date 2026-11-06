/**
 * POST /api/exams/[id]/sessions — start one block of the day as its own
 * session: { kind: placement | practice | review | teach | mock, pointId? }
 * → { id, title, opening, kind }; the client sends `opening` as the
 * learner's first message. 409 when the block has nothing to do.
 */
import { parseSessionStart, startExamSession } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const parsed = parseSessionStart(await request.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const started = startExamSession(id, parsed.value.kind, parsed.value.pointId);
	if (!started.ok) return Response.json({ error: started.error }, { status: started.status });
	return Response.json(started.session);
}
