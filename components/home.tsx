"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeftIcon, DumbbellIcon } from "lucide-react";
import Link from "next/link";
import { ChainTableOverlay } from "@/components/chain-table.tsx";
import { SessionRow, useChatList } from "@/components/sessions";
import { SetupDialog } from "@/components/setup-dialog";
import { ComposerActions, NodePickerControl } from "@/components/composer-actions";
import { useModelSetup, selectedModelUnavailable, openModelPicker, ZeroKeysPill } from "@/components/setup-cta";
import { DictationBar, joinDictation, useDictation } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { StatsBar } from "@/components/stats-bar";
import { OPENING_PROMPT_FAILURE } from "@/components/opening-prompt";
import { SessionStarter } from "@/components/start-session";
import type { ChatListItem, GraphSnapshot, TurnUsage } from "@/src/core";
import { useT } from "@/components/i18n";

/** «Seguir con»: what needs you first (your turn, a waiting problem, the
 *  tutor working), then the most recent — three at most. Pure — tested. */
export function continueWith(chats: readonly ChatListItem[], limit = 3): ChatListItem[] {
	const attention = (c: ChatListItem) =>
		c.pendingQuestion || ((c.kind ?? "teach") === "practice" && c.pendingProblem) || c.busy || c.compacting ? 0 : 1;
	return [...chats]
		.sort((a, b) => attention(a) - attention(b) || b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, limit);
}

/** The practice picker without the graph tab: Inicio owns the chain
 *  table (select mode) and loads the snapshot only while it is open. */
function PracticePicker({
	open,
	selection,
	onSelectionChange,
	onClose,
}: {
	open: boolean;
	selection: ReadonlySet<string>;
	onSelectionChange: (picked: { id: string; name: string; statement: string }[]) => void;
	onClose: () => void;
}) {
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	useEffect(() => {
		if (!open) return;
		fetch("/api/graph")
			.then((res) => res.json() as Promise<GraphSnapshot>)
			.then(setSnapshot)
			.catch(() => {});
	}, [open]);
	return (
		<ChainTableOverlay
			open={open && (snapshot?.propositions.length ?? 0) > 0}
			nodes={snapshot?.propositions ?? []}
			chains={snapshot?.chains ?? []}
			sessions={snapshot?.sessions ?? {}}
			fileSources={snapshot?.fileSources ?? {}}
			onClose={onClose}
			selectMode
			controlledSelection={selection}
			onSelectionChange={(ids) => {
				const props = snapshot?.propositions ?? [];
				const picked: { id: string; name: string; statement: string }[] = [];
				for (const id of ids) {
					const n = props.find((node) => node.id === id);
					if (n) picked.push({ id: n.id, name: n.name, statement: n.statement });
				}
				onSelectionChange(picked);
			}}
		/>
	);
}

/**
 * INICIO (Naipes interface, stage 3): «¿Qué quieres aprender?» — the
 * teach/practice composer — then «Seguir con» (the sessions that need you).
 * The knowledge graph moved to its own tab; picking ideas for practice
 * opens the chain table right here.
 */
export function Home({ initialConfigured }: { initialConfigured: boolean }) {
	const t = useT();
	const router = useRouter();
	const [topic, setTopic] = useState("");
	/* The topic MIRROR ("nothing gets lost" round, 2026-10-01 — same
	 * mechanics as the chat composer, owner's consistency ruling): a
	 * dictation flush lands via setState, invisible to a closure that
	 * waited through `await finish()`. Kept current at every write. */
	const topicRef = useRef("");
	// First-run gate (model-slots wave, owner 2026-09-20): chats cannot
	// start until the user has picked all three slots — no defaults for
	// 33 providers. The dock shows the CTA while unconfigured; submitting
	// a topic opens the setup dialog WITH THE DRAFT PRESERVED (Save
	// stores slots only; the learner sends the message themselves).
	const { catalog, configured, zeroKeys } = useModelSetup(initialConfigured);
	const [setupOpen, setSetupOpen] = useState(false);
	// Voice dictation (STT wave, 2026-09-17): finals append at the end of the
	// topic draft; the strip lives in the stats bar's middle slot.
	const dictation = useDictation({
		// Ref-first: the join reads the mirror so the send resuming after
		// `await finish()` sees the dictated tail.
		append: (text) => {
			const v = joinDictation(topicRef.current, text);
			topicRef.current = v;
			setTopic(v);
		},
	});
	const [busy, setBusy] = useState(false);
	const startingRef = useRef(false);
	const starterRef = useRef(new SessionStarter());
	const [startError, setStartError] = useState(false);
	/* Run end focuses the topic input (owner, 2026-10-01): the hands are on
	 * the keyboard from the stop. Falling edge only; this surface's only
	 * dictation target IS this textarea, so no case-split is needed. */
	const topicInputRef = useRef<HTMLTextAreaElement>(null);
	// Tab navigates INTO the topic composer (owner, keyboard round
	// 2026-10-06): the only text field on this surface — and home's
	// composer is its OWN textarea, not the shared Composer component,
	// so the chain is the ref itself (the smoke caught a selector that
	// matched nothing here).
	const cycleTopicField = useCallback(
		(): readonly HTMLElement[] => (topicInputRef.current ? [topicInputRef.current] : []),
		[],
	);
	useFieldCycle(cycleTopicField);
	const dictationWasActiveRef = useRef(false);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			topicInputRef.current?.focus();
		}
	}, [dictation.active]);

	/* PRACTICE MODE (owner, 2026-10-04): the graph composer's teach |
	 *  practice switch — practice creates a kind:"practice" session and
	 *  may carry proposition picks from the chain table (the chip above
	 *  the composer opens the picker; the picks seed the opening prompt).
	 *  Not enforcing any input format — the picks are a convenience. */
	const [mode, setMode] = useState<"teach" | "practice">("teach");
	const [practiceProps, setPracticeProps] = useState<{ id: string; name: string; statement: string }[]>([]);
	const [chainSelectOpen, setChainSelectOpen] = useState(false);
	// The chain table is CONTROLLED off this id set (the lifted pick).
	const pickedIds = useMemo(() => new Set(practiceProps.map((p) => p.id)), [practiceProps]);

	/* FINISH DICTATION FIRST (owner, 2026-10-01): Enter may arrive while a
	 * run is live with the topic still deferred in the run's buffer — stop
	 * the run, let the last finals land, THEN read the REF mirror (not the
	 * state closure) and run. Applies before the setup/key guards too, so
	 * an intercepted draft is the complete one. */
	const start = () => {
		if (!dictation.active) {
			void begin();
			return;
		}
		void dictation.finish().then(() => begin());
	};
	const begin = async () => {
		const title = topicRef.current.trim();
		if (!title || startingRef.current) return;
		// Unconfigured: the send INTERCEPTS into the setup flow (the draft
		// stays in the textarea; the learner sends it after Save).
		if (!configured) {
			setSetupOpen(true);
			return;
		}
		// The pre-send KEY guards (owner interlude, no-orphan-chats): the
		// models case guards BEFORE creation; the key cases must too — a
		// refused first send would otherwise leave an orphan error-shell
		// chat in the sidebar (the 503 lands only after POST /api/chats
		// already created the record). Zero providers opens connection setup;
		// an unavailable selection with another provider opens its ordinary
		// picker. The server's admission gate remains the belt.
		if (zeroKeys) {
			setSetupOpen(true);
			return;
		}
		const strong = catalog?.slots.strong?.model;
		if (selectedModelUnavailable(catalog, strong ? `${strong.provider}:${strong.id}` : undefined)) {
			openModelPicker();
			return; // Preserve the draft and never create an orphan session.
		}
		startingRef.current = true;
		setBusy(true);
		setStartError(false);
		try {
			// The map context (owner, 2026-10-04): picks in EITHER mode ride
			// the CREATION as graphContext — the server writes a
			// graph-context marker as message[0] (a separate custom message
			// before the learner's first user message, propositions + the
			// chains among them); the prompt stays the learner's own words.
			const target = await starterRef.current.start({
				title,
				...(mode === "practice" ? { kind: "practice" } : {}),
				...(practiceProps.length > 0 ? { graphContext: { propositions: practiceProps } } : {}),
			}, fetch, JSON.stringify(catalog?.slots.strong));
			router.push(target);
		} catch {
			startingRef.current = false;
			setBusy(false);
			setStartError(true);
		}
	};

	const { chats } = useChatList();
	const recent = chats ? continueWith(chats) : null;

	return (
		<div className="h-full overflow-y-auto" data-testid="start-page">
			<div className="mx-auto flex w-full max-w-[46rem] flex-col gap-10 px-4 pb-16 pt-[12vh]">
				<section className="flex flex-col gap-4">
					<h1 className="px-1 text-[26px] font-semibold leading-[34px] tracking-tight">{t("graph.home.placeholderLearn")}</h1>
					<div>
					{/* The pick bar (owner vision, 2026-10-04): the chain
					    table's selection is PERSISTENT — picked
					    propositions show here as a count + Clear in EITHER
					    mode (it survives mode switches; only a practice
					    send consumes it). Practice mode with nothing picked
					    shows the pick HINT so the affordance is discoverable;
					    teaching mode with nothing picked renders nothing. */}
					<ComposerActions
						picker={(practiceProps.length > 0 || mode === "practice") && (
							<NodePickerControl
								count={practiceProps.length}
								onOpen={() => setChainSelectOpen(true)}
								onClear={() => setPracticeProps([])}
							/>
						)}
						setup={zeroKeys ? (
							<ZeroKeysPill inline onOpen={() => setSetupOpen(true)} />
						) : (
							!configured && (
								<button
									type="button"
									data-testid="setup-cta"
									onClick={() => setSetupOpen(true)}
									className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
								>
									{t("graph.setup.title")}
								</button>
							)
						)}
					/>
					{startError && <p role="alert" className="mb-2 text-sm text-destructive">{OPENING_PROMPT_FAILURE}</p>}
					<form
						className="flex items-end gap-1.5 rounded-2xl border bg-card p-1.5 shadow-lg"
					onSubmit={(e) => {
						e.preventDefault();
						void start();
					}}
				>
					<textarea
						ref={topicInputRef}
						value={topic}
						onChange={(e) => {
							topicRef.current = e.target.value;
							setTopic(e.target.value);
						}}
						onKeyDown={(e) => {
							// Esc ends dictation (the dictate decisions: click-again or
							// Esc) — stopPropagation claims it (keyboard wave A) so
							// the window chain doesn't also abort a turn.
							if (e.key === "Escape" && dictation.active) {
								e.preventDefault();
								e.stopPropagation();
								dictation.cancel();
								return;
							}
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void start();
							}
						}}
						placeholder={mode === "practice" ? t("graph.home.placeholderPractice") : t("graph.home.placeholderLearn")}
						autoFocus
						rows={1}
						className="field-sizing-content np-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
					/>
					{/* No tooltip on the start square — the ↵ glyph is the
					    affordance (owner, subtlety round 2026-09-25). */}
					<button
						type="submit"
						aria-label={t("graph.home.start")}
						disabled={(!topic.trim() && !dictation.active) || busy}
						className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-40"
					>
						<CornerDownLeftIcon className="size-5" />
					</button>
					</form>
					{/* Same as the chat view's under-composer stats bar (owner) — no
					    session yet, so the LEFT side renders nothing (wave 7 sweep)
					    while the RIGHT keeps the strong-slot control (fix wave: the
					    pills write /api/settings/models). */}
					<StatsBar
						dictationSlot={<DictationBar dictation={dictation} />}
						turns={[] as TurnUsage[]}
						leadingSlot={
							<div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid="home-mode-switch">
								{(["teach", "practice"] as const).map((m) => (
									<button
										key={m}
										type="button"
										data-testid={`home-mode-${m}`}
										onClick={() => setMode(m)}
										className={
											"flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors " +
											(mode === m
												? "bg-accent text-foreground"
												: "text-muted-foreground hover:text-foreground")
										}
									>
										{m === "practice" ? <DumbbellIcon aria-hidden="true" className="size-3" /> : null}
										{m === "teach" ? t("graph.home.teach") : t("graph.home.practice")}
									</button>
								))}
							</div>
						}
					/>
					</div>
				</section>

				{recent && recent.length > 0 && (
					<section className="flex flex-col gap-3" data-testid="continue-with">
						<div className="flex items-baseline justify-between px-1">
							<h2 className="text-lg font-semibold">{t("sessions.continueWith")}</h2>
							<Link href="/sessions" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
								{t("sessions.seeAll")}
							</Link>
						</div>
						<div className="overflow-hidden rounded-xl border">
							{recent.map((c) => (
								<SessionRow key={c.id} chat={c} active={false} onOpen={() => router.push(`/chat/${c.id}`)} />
							))}
						</div>
					</section>
				)}
			</div>

			<PracticePicker
				open={chainSelectOpen}
				selection={pickedIds}
				onSelectionChange={setPracticeProps}
				onClose={() => setChainSelectOpen(false)}
			/>

			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					setSetupOpen(false);
					// Save only saves: the draft waits in the composer.
				}}
				/>
		</div>
	);
}
