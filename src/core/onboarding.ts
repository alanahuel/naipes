/**
 * «Primeros pasos» / «Novedades» (owner, 2026-11-09) — the onboarding
 * registry and its pure view logic. Browser-safe.
 *
 * ONE registry feeds two experiences:
 *   - the GUIDE: the steps (entries with a `phase`) in dependency order,
 *     unlocked phase by phase — the next phase shows once every step of the
 *     current one is done or skipped. A step is DONE by a local-state
 *     detector (server/onboarding.ts) — nobody is "measured" as new: a
 *     fresh install has every step pending, a long-time user has most done.
 *   - NOVEDADES: after an update, the entries whose version is newer than
 *     the last version the learner saw (settings `onboarding.lastSeenVersion`).
 *
 * «Ocultar» hides the guide for good; an update that brings NEW steps
 * (version newer than the hide) shows those steps only.
 *
 * Every release adds its entries here — scripts/check-onboarding.ts fails
 * a release with `feat:` commits and no entry for its version (a `silent`
 * entry is the explicit «sin novedades»). Copy lives in the `onboarding`
 * message zone: `onboarding.entry.<id>.title` / `.body`.
 */

export type OnboardingStepId =
	| "provider"
	| "models"
	| "firstSession"
	| "practice"
	| "folder"
	| "inbox"
	| "review"
	| "exam"
	| "photo"
	| "dictation"
	| "mcp";

export const ONBOARDING_STEP_IDS: readonly OnboardingStepId[] = [
	"provider",
	"models",
	"firstSession",
	"practice",
	"folder",
	"inbox",
	"review",
	"exam",
	"photo",
	"dictation",
	"mcp",
];

export function isOnboardingStepId(value: unknown): value is OnboardingStepId {
	return typeof value === "string" && (ONBOARDING_STEP_IDS as readonly string[]).includes(value);
}

/** Where a step's «pruébalo» goes. */
export type OnboardingTarget =
	/** The first-run setup dialog (provider key → model slots). */
	| { kind: "setup" }
	/** Inicio's composer, in this mode, focused. */
	| { kind: "composer"; mode: "teach" | "practice" }
	/** An app route. */
	| { kind: "href"; href: string }
	/** The most recent active session (first of «Seguir con»). */
	| { kind: "recentSession" };

export type OnboardingPhase = 1 | 2 | 3;

export interface OnboardingEntry {
	/** A step id, or a text-only entry's own id (its message keys). */
	id: string;
	/** The release that brought it ("X.Y.Z"). */
	version: string;
	/** Guide phase — steps only; text-only entries have none. */
	phase?: OnboardingPhase;
	target?: OnboardingTarget;
	/** «Sin novedades»: satisfies the release check, never shown. */
	silent?: boolean;
}

export const ONBOARDING_PHASES: readonly OnboardingPhase[] = [1, 2, 3];

/** THE registry, in guide order (steps) then release order (text-only). */
export const ONBOARDING_ENTRIES: readonly OnboardingEntry[] = [
	// Phase 1 — Empezar
	{ id: "provider", version: "0.1.0", phase: 1, target: { kind: "setup" } },
	{ id: "models", version: "0.1.0", phase: 1, target: { kind: "setup" } },
	{ id: "firstSession", version: "0.1.0", phase: 1, target: { kind: "composer", mode: "teach" } },
	// Phase 2 — Aprender a fondo
	{ id: "practice", version: "0.1.0", phase: 2, target: { kind: "composer", mode: "practice" } },
	{ id: "folder", version: "0.3.0", phase: 2, target: { kind: "href", href: "/settings/connections" } },
	{ id: "inbox", version: "0.5.0", phase: 2, target: { kind: "href", href: "/settings/connections" } },
	{ id: "review", version: "0.2.0", phase: 2, target: { kind: "href", href: "/review" } },
	// Phase 3 — Ir más allá
	{ id: "exam", version: "0.6.0", phase: 3, target: { kind: "href", href: "/exams/new" } },
	{ id: "photo", version: "0.10.0", phase: 3, target: { kind: "recentSession" } },
	{ id: "dictation", version: "0.15.0", phase: 3, target: { kind: "composer", mode: "teach" } },
	{ id: "mcp", version: "0.13.0", phase: 3, target: { kind: "href", href: "/settings/connections" } },
	// Text-only Novedades (improvements that need no action)
	{ id: "uxAudit", version: "0.12.0" },
	{ id: "batchProgress", version: "0.14.0" },
	{ id: "probeMemory", version: "0.16.0" },
	{ id: "examPrerequisites", version: "0.17.0" },
	{ id: "onboarding", version: "0.18.0" },
	{ id: "examTabs", version: "0.19.0" },
];

/** Compare "X.Y.Z" versions (pre-release suffixes ignored). */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) => (v.replace(/^v/, "").split("-")[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pa = parts(a);
	const pb = parts(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

/** The persisted onboarding preferences (settings `onboarding`). */
export interface OnboardingSettings {
	/** The app version whose Novedades the learner has seen. */
	lastSeenVersion?: string;
	/** Steps skipped with «omitir». */
	skipped?: OnboardingStepId[];
	/** «Ocultar»: the app version at the time. Only newer steps return. */
	hiddenAtVersion?: string;
	/** First dictation (ISO) — the only detector with no other trace. */
	dictationUsedAt?: string;
}

export type OnboardingDone = Readonly<Record<OnboardingStepId, boolean>>;

export interface OnboardingRow {
	entry: OnboardingEntry;
	/** Steps: done / skipped / pending. Text-only entries: "info". */
	status: "done" | "skipped" | "pending" | "info";
}

export type OnboardingView =
	| {
			mode: "guide";
			/** The phase on show; null for post-hide new steps (no phase gate). */
			phase: OnboardingPhase | null;
			rows: OnboardingRow[];
			/** Done or skipped, over every step. */
			completed: number;
			total: number;
	  }
	| { mode: "news"; version: string; rows: OnboardingRow[] };

const isStep = (e: OnboardingEntry): e is OnboardingEntry & { id: OnboardingStepId; phase: OnboardingPhase } =>
	e.phase !== undefined && isOnboardingStepId(e.id);

function stepStatus(id: OnboardingStepId, done: OnboardingDone, skipped: ReadonlySet<string>): OnboardingRow["status"] {
	if (done[id]) return "done";
	return skipped.has(id) ? "skipped" : "pending";
}

/**
 * What the card shows, or null for nothing.
 *   - lastSeenVersion older than `version` → NOVEDADES: the non-silent
 *     entries in (lastSeen, version]; null when there are none.
 *   - otherwise → the GUIDE: not hidden → the first phase with a pending
 *     step (its done/skipped rows shown too); hidden → only the pending
 *     steps newer than the hide, ungated. Null when nothing is pending.
 * An absent lastSeenVersion (fresh install, or a user from before the
 * onboarding existed) is the guide — the caller then records `version`.
 */
export function onboardingView(input: {
	settings: OnboardingSettings | undefined;
	done: OnboardingDone;
	version: string;
	entries?: readonly OnboardingEntry[];
}): OnboardingView | null {
	const { done, version } = input;
	const settings = input.settings ?? {};
	const entries = input.entries ?? ONBOARDING_ENTRIES;
	const skipped = new Set<string>(settings.skipped ?? []);
	const released = entries.filter((e) => !e.silent && compareVersions(e.version, version) <= 0);

	const lastSeen = settings.lastSeenVersion;
	if (lastSeen && compareVersions(lastSeen, version) < 0) {
		const rows = released
			.filter((e) => compareVersions(e.version, lastSeen) > 0)
			.map((entry): OnboardingRow => ({ entry, status: isStep(entry) ? stepStatus(entry.id, done, skipped) : "info" }));
		return rows.length > 0 ? { mode: "news", version, rows } : null;
	}

	const steps = released.filter(isStep);
	const total = steps.length;
	const completed = steps.filter((s) => stepStatus(s.id, done, skipped) !== "pending").length;

	if (settings.hiddenAtVersion) {
		const hiddenAt = settings.hiddenAtVersion;
		const rows = steps
			.filter((s) => compareVersions(s.version, hiddenAt) > 0 && stepStatus(s.id, done, skipped) === "pending")
			.map((entry): OnboardingRow => ({ entry, status: "pending" }));
		return rows.length > 0 ? { mode: "guide", phase: null, rows, completed, total } : null;
	}

	for (const phase of ONBOARDING_PHASES) {
		const inPhase = steps.filter((s) => s.phase === phase);
		if (!inPhase.some((s) => stepStatus(s.id, done, skipped) === "pending")) continue;
		const rows = inPhase.map((entry): OnboardingRow => ({ entry, status: stepStatus(entry.id, done, skipped) }));
		return { mode: "guide", phase, rows, completed, total };
	}
	return null;
}

/** Whether the learner should have `version` recorded as seen now: a
 *  first read (no lastSeenVersion) or an update (older one). */
export function onboardingNeedsSeen(settings: OnboardingSettings | undefined, version: string): boolean {
	const lastSeen = settings?.lastSeenVersion;
	return !lastSeen || compareVersions(lastSeen, version) < 0;
}

/** The release gate's question: does the registry carry an entry (shown
 *  or silent) for this version? */
export function hasOnboardingEntryFor(version: string, entries: readonly OnboardingEntry[] = ONBOARDING_ENTRIES): boolean {
	return entries.some((e) => compareVersions(e.version, version) === 0);
}

/** Sanitize a stored `onboarding` section (unknown/invalid parts dropped). */
export function sanitizeOnboardingSettings(raw: unknown): OnboardingSettings {
	const out: OnboardingSettings = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
	const r = raw as Record<string, unknown>;
	const isVersion = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+/.test(v);
	if (isVersion(r.lastSeenVersion)) out.lastSeenVersion = r.lastSeenVersion;
	if (isVersion(r.hiddenAtVersion)) out.hiddenAtVersion = r.hiddenAtVersion;
	if (Array.isArray(r.skipped)) {
		const skipped = [...new Set(r.skipped.filter(isOnboardingStepId))];
		if (skipped.length > 0) out.skipped = skipped;
	}
	if (typeof r.dictationUsedAt === "string" && !Number.isNaN(Date.parse(r.dictationUsedAt))) out.dictationUsedAt = r.dictationUsedAt;
	return out;
}

/** One write to the onboarding section (POST /api/onboarding). */
export type OnboardingOp =
	| { op: "seen"; version: string }
	| { op: "skip"; id: OnboardingStepId }
	| { op: "hide"; version: string }
	| { op: "dictationUsed" };

export function parseOnboardingOp(body: unknown): OnboardingOp | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
	const b = body as Record<string, unknown>;
	const version = typeof b.version === "string" && /^\d+\.\d+\.\d+/.test(b.version) ? b.version : null;
	switch (b.op) {
		case "seen":
			return version ? { op: "seen", version } : null;
		case "hide":
			return version ? { op: "hide", version } : null;
		case "skip":
			return isOnboardingStepId(b.id) ? { op: "skip", id: b.id } : null;
		case "dictationUsed":
			return { op: "dictationUsed" };
		default:
			return null;
	}
}

/** Apply one op — pure; `now` stamps dictationUsedAt (first use kept). */
export function applyOnboardingOp(settings: OnboardingSettings | undefined, op: OnboardingOp, now: Date): OnboardingSettings {
	const s: OnboardingSettings = { ...(settings ?? {}) };
	switch (op.op) {
		case "seen":
			if (!s.lastSeenVersion || compareVersions(s.lastSeenVersion, op.version) < 0) s.lastSeenVersion = op.version;
			return s;
		case "hide":
			s.hiddenAtVersion = op.version;
			return s;
		case "skip":
			s.skipped = [...new Set([...(s.skipped ?? []), op.id])];
			return s;
		case "dictationUsed":
			if (!s.dictationUsedAt) s.dictationUsedAt = now.toISOString();
			return s;
	}
}

/** GET /api/onboarding's body. */
export interface OnboardingResponse {
	settings: OnboardingSettings;
	done: OnboardingDone;
}
