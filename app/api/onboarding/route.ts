/**
 * «Primeros pasos» / «Novedades» (owner, 2026-11-09).
 *
 *   GET  → 200 OnboardingResponse: the stored onboarding preferences +
 *          every step's local-state detector.
 *   POST → one op ({op:"seen",version} | {op:"skip",id} |
 *          {op:"hide",version} | {op:"dictationUsed"}) applied to the
 *          onboarding settings section → 200 {settings}; 400 on a bad op.
 */
import { parseOnboardingOp } from "@/src/core";
import { applyOnboarding, onboardingResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(onboardingResponse());
}

export async function POST(request: Request) {
	const op = parseOnboardingOp(await request.json().catch(() => null));
	if (!op) return Response.json({ error: "invalid onboarding op" }, { status: 400 });
	return Response.json({ settings: applyOnboarding(op) });
}
