/**
 * POST   /api/stt/whisper/:model — start downloading a Whisper model
 *        (202; progress via GET /api/stt/whisper).
 * DELETE /api/stt/whisper/:model — cancel its download (partial files
 *        removed) or, when not downloading, delete it from disk.
 */
import { isWhisperModelId } from "@/src/core";
import { cancelOrDeleteWhisperModel, startWhisperDownload, whisperModelStatuses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ model: string }> }) {
	const { model } = await ctx.params;
	if (!isWhisperModelId(model)) return Response.json({ error: "Unknown Whisper model" }, { status: 404 });
	startWhisperDownload(model);
	return Response.json({ models: whisperModelStatuses() }, { status: 202 });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ model: string }> }) {
	const { model } = await ctx.params;
	if (!isWhisperModelId(model)) return Response.json({ error: "Unknown Whisper model" }, { status: 404 });
	await cancelOrDeleteWhisperModel(model);
	return Response.json({ models: whisperModelStatuses() });
}
