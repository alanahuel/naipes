/**
 * The onboarding's writes from the client (owner, 2026-11-09) — one POST
 * per op to /api/onboarding; failures are silent (onboarding is a hint,
 * never a gate).
 */
import type { OnboardingOp } from "@/src/core";

export function postOnboarding(op: OnboardingOp): Promise<unknown> {
	return fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) }).catch(() => null);
}

/** The learner dictated something — the dictation step's only trace.
 *  Once per app run is enough: the server keeps the first stamp. */
let dictationMarked = false;
export function markDictationUsed(): void {
	if (dictationMarked) return;
	dictationMarked = true;
	void postOnboarding({ op: "dictationUsed" });
}
