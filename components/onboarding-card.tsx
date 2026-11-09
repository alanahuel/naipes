"use client";
/**
 * «Primeros pasos» / «Novedades» on Inicio (owner, 2026-11-09): the first
 * card under the composer. The registry, the phases and the view logic
 * live in core/onboarding.ts; the detectors in server/onboarding.ts.
 *
 * Seen-version: the first read (or the first after an update) records the
 * running version at once. The Novedades of an update stay on screen for
 * this visit — the card keeps the version it loaded with — and show once.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CircleIcon, CircleSlashIcon, SparklesIcon } from "lucide-react";
import {
	onboardingNeedsSeen,
	onboardingView,
	type MessageKey,
	type OnboardingResponse,
	type OnboardingPhase,
	type OnboardingRow,
	type OnboardingStepId,
	type OnboardingTarget,
	isOnboardingStepId,
} from "@/src/core";
import { APP_VERSION } from "@/components/settings/update-settings.tsx";
import { useSettingsSaved } from "@/components/settings-signal";
import { SectionTitle } from "@/components/ui/page";
import { ListCard, ListRow } from "@/components/ui/list";
import { buttonVariants } from "@/components/ui/button";
import { useT } from "@/components/i18n";
import { postOnboarding as post } from "@/components/onboarding-signal";

const PHASE_KEY: Record<OnboardingPhase, MessageKey> = {
	1: "onboarding.phase.start",
	2: "onboarding.phase.deepen",
	3: "onboarding.phase.beyond",
};

export function OnboardingCard({
	version = APP_VERSION,
	recentSessionId,
	onTarget,
}: {
	version?: string;
	/** The first of «Seguir con» — the photo step's destination. */
	recentSessionId: string | null;
	onTarget: (target: OnboardingTarget) => void;
}) {
	const t = useT();
	const [data, setData] = useState<OnboardingResponse | null>(null);
	/** The lastSeenVersion this visit started with (null = not loaded). */
	const baseSeen = useRef<string | undefined | null>(null);
	const [closed, setClosed] = useState(false);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/onboarding", { cache: "no-store" });
			if (!res.ok) return;
			const body = (await res.json()) as OnboardingResponse;
			if (baseSeen.current === null) {
				baseSeen.current = body.settings.lastSeenVersion;
				if (version && onboardingNeedsSeen(body.settings, version)) void post({ op: "seen", version });
			}
			setData(body);
		} catch {
			/* keep the last snapshot */
		}
	}, [version]);

	useEffect(() => {
		void load();
		const onFocus = () => void load();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [load]);
	useSettingsSaved(() => void load());

	if (!data || !version || closed || baseSeen.current === null) return null;
	const view = onboardingView({
		settings: { ...data.settings, lastSeenVersion: baseSeen.current },
		done: data.done,
		version,
	});
	if (!view) return null;

	const skip = (id: OnboardingStepId) => {
		setData((d) => (d ? { ...d, settings: { ...d.settings, skipped: [...(d.settings.skipped ?? []), id] } } : d));
		void post({ op: "skip", id });
	};
	const hide = () => {
		setClosed(true);
		if (view.mode === "guide") void post({ op: "hide", version });
	};

	const title =
		view.mode === "news"
			? t("onboarding.news.title", { version: view.version.split(".").slice(0, 2).join(".") })
			: view.phase === null
				? t("onboarding.guide.newSteps")
				: t(PHASE_KEY[view.phase]);

	return (
		<section className="flex flex-col gap-3" data-testid="onboarding-card" data-mode={view.mode}>
			<SectionTitle
				right={
					<span className="flex items-center gap-3">
						{view.mode === "guide" && (
							<span className="font-ui text-xs text-muted-foreground" data-testid="onboarding-progress">
								{t("onboarding.guide.progress", { done: view.completed, total: view.total })}
							</span>
						)}
						<button type="button" data-testid="onboarding-hide" onClick={hide} className={buttonVariants({ variant: "ghost", size: "xs" })}>
							{view.mode === "news" ? t("onboarding.close") : t("onboarding.hide")}
						</button>
					</span>
				}
			>
				{view.mode === "guide" ? (
					<>
						{t("onboarding.guide.title")}
						<span className="font-normal text-muted-foreground"> · {title}</span>
					</>
				) : (
					title
				)}
			</SectionTitle>
			<ListCard>
				{view.rows.map((row) => (
					<Row key={row.entry.id} row={row} recentSessionId={recentSessionId} onTarget={onTarget} onSkip={skip} />
				))}
			</ListCard>
		</section>
	);
}

function Row({
	row,
	recentSessionId,
	onTarget,
	onSkip,
}: {
	row: OnboardingRow;
	recentSessionId: string | null;
	onTarget: (target: OnboardingTarget) => void;
	onSkip: (id: OnboardingStepId) => void;
}) {
	const t = useT();
	const { entry, status } = row;
	const key = (part: "title" | "body") => `onboarding.entry.${entry.id}.${part}` as MessageKey;
	const target = entry.target;
	const needsSession = target?.kind === "recentSession" && !recentSessionId;
	const leading =
		status === "done" ? (
			<CheckIcon aria-label={t("onboarding.status.done")} className="size-4 shrink-0 text-ok" />
		) : status === "skipped" ? (
			<CircleSlashIcon aria-label={t("onboarding.status.skipped")} className="size-4 shrink-0 text-muted-foreground" />
		) : status === "info" ? (
			<SparklesIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
		) : (
			<CircleIcon aria-label={t("onboarding.status.pending")} className="size-4 shrink-0 text-muted-foreground" />
		);
	const meta = needsSession && status === "pending" ? t("onboarding.entry.photo.needsSession") : t(key("body"));
	return (
		<ListRow
			testid={`onboarding-row-${entry.id}`}
			leading={leading}
			title={t(key("title"))}
			meta={meta}
			className={status === "done" || status === "skipped" ? "opacity-60" : undefined}
			action={
				status === "pending" && target ? (
					<>
						{isOnboardingStepId(entry.id) && entry.phase !== undefined && (
							<button type="button" data-testid={`onboarding-skip-${entry.id}`} onClick={() => onSkip(entry.id as OnboardingStepId)} className="font-ui text-xs text-muted-foreground transition-colors hover:text-foreground">
								{t("onboarding.skip")}
							</button>
						)}
						{!needsSession && (
							<button type="button" data-testid={`onboarding-try-${entry.id}`} onClick={() => onTarget(target)} className={buttonVariants({ variant: "outline", size: "sm" })}>
								{t("onboarding.try")}
							</button>
						)}
					</>
				) : undefined
			}
		/>
	);
}
