/**
 * GET /stt-models/whisper-<id>/<file> — the local Whisper engine's model
 * files (transformers.js localModelPath = "/stt-models/").
 *
 * Deliberately OUTSIDE /api: the engine runs in a Web Worker, and worker
 * requests never carry the desktop capability header (it is attached to
 * the main frame only — electron/desktop-api.cjs). What is served here is
 * public, pinned model weights: only manifest files of a fully downloaded
 * model resolve (src/server/whisper-models.ts) — never anything else under
 * the data dir. Read-only, GET only.
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { whisperModelFile } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ path: string[] }> }) {
	const { path: segments } = await ctx.params;
	const [dir, ...rest] = segments;
	const file = dir ? whisperModelFile(dir, rest.join("/")) : null;
	if (!file) return new Response(null, { status: 404 });
	const type = file.path.endsWith(".json") ? "application/json" : "application/octet-stream";
	const body = Readable.toWeb(fs.createReadStream(file.path)) as ReadableStream<Uint8Array>;
	return new Response(body, { headers: { "Content-Type": type, "Content-Length": String(file.size), "Cache-Control": "no-store" } });
}
