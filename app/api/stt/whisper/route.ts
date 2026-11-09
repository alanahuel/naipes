/**
 * GET /api/stt/whisper — every local Whisper model's state for Settings →
 * Dictation: missing | downloading (+ bytes received) | ready | error.
 * Polled while a download runs (src/server/whisper-models.ts).
 */
import { whisperModelStatuses } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json({ models: whisperModelStatuses() }, { headers: { "Cache-Control": "no-store" } });
}
