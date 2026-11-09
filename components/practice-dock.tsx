"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { joinDictation, useDictationTarget } from "@/components/dictation";
import { useEnterSubmits } from "@/components/enter-submits";
import { cn } from "@/lib/utils";
import { useT } from "@/components/i18n";
import { ConfidenceSlider } from "@/components/confidence-rail";
import type { AttachmentRef } from "@/src/core";
import { AttachButton, AttachmentTrayView, useAttachmentTray } from "@/components/attachments";

/**
 * The practice dock (practice sessions, owner design 2026-10-04): an
 * ACTIVE problem replaces the chat composer — the persistent bottom blob
 * morphs into the problem. The agent's statement above; the learner's
 * half below — "Your thinking", a labeled field with ONE Send button
 * (owner round 2, 2026-10-05): Enter sends, Shift+Enter makes a newline.
 * There are no lanes — whether a submission claims an answer is apparent
 * from the thinking itself; the agent reads it. One problem may carry
 * many submissions; each starts a turn.
 *
 * Collapse (scroll-up → slim bar) is owned by the DockOverlay; this
 * component is content only, and the expanded form stays MOUNTED while
 * collapsed (hidden) so a half-written trace survives scrolling.
 *
 * The commitment (modelSolution, decisionPoints, …) rides the tool call's
 * arguments and is NOT rendered here — only the statement is the
 * learner's. Esc dismisses the problem (the layered-Esc chain; the
 * confirm dialog then the silent route) — claimed by the page, not here.
 */

export interface PracticeDockProps {
	/** The active problem's tool-call id (submissions target it). */
	problemCallId: string;
	/** The pose's arguments — only the statement is the learner's (the
	 *  mode badge would edge toward announcing the target; dropped). */
	input: { statement: string };
	/** Collapse state, owned by the DockOverlay. */
	expanded: boolean;
	onExpand: () => void;
	/** text — POST {type:"thinking"} (one lane; the register is read from
	 *  the text) with the learner's stated confidence (owner, 2026-11-05). */
	onSubmit: (text: string, confidence: number, attachments?: readonly AttachmentRef[]) => void;
	/** Escape in the thinking field stops dictation (threaded from the page). */
	onEscape?: () => void;
	/** Compaction is running for this chat (owner round 14): the thinking
	 *  POST would block on the server's compaction gate — disable submit
	 *  and say so in the hint row. The server registry is the real gate;
	 *  this is the affordance. */
	compactionRunning?: boolean;
}

export function PracticeDock({ problemCallId, input, expanded, onExpand, onSubmit, onEscape, compactionRunning = false }: PracticeDockProps) {
	const t = useT();
	const [thinking, setThinking] = useState("");
	// The stated confidence (owner, 2026-11-05 — «Exámenes»), NEVER
	// pre-filled (owner 2026-11-09): null until the learner picks a stop;
	// any change to the answer (typing, dictation, photos) and every
	// submission empty it again, so each send carries a fresh choice.
	const [confidence, setConfidence] = useState<number | null>(null);
	const confidenceRef = useRef<number | null>(null);
	const [confidenceMissing, setConfidenceMissing] = useState(false);
	const clearConfidence = useCallback(() => {
		confidenceRef.current = null;
		setConfidence(null);
	}, []);
	useEffect(() => {
		clearConfidence();
		setConfidenceMissing(false);
	}, [problemCallId, clearConfidence]);
	// Ref MIRRORS the field ("nothing gets lost", the question-dock
	// discipline): a submit resuming after `await finishDictation()` reads
	// the tail, never a stale closure.
	const thinkingRef = useRef("");
	// Photos of the paper working (owner, 2026-11-06 — the reason the
	// feature exists): the same tray as the composer.
	const tray = useAttachmentTray();
	// Adding or removing a photo changes the answer too.
	const trayCount = useRef(tray.count);
	useEffect(() => {
		if (trayCount.current === tray.count) return;
		trayCount.current = tray.count;
		clearConfidence();
	}, [tray.count, clearConfidence]);

	useDictationTarget(
		useCallback(
			(t: string) => {
				const v = joinDictation(thinkingRef.current, t);
				thinkingRef.current = v;
				setThinking(v);
				clearConfidence();
			},
			[clearConfidence],
		),
		true,
	);

	const submit = () => {
		if (compactionRunning || tray.uploading) return;
		const text = thinkingRef.current.trim();
		if (text.length === 0 && tray.count === 0) return;
		const stated = confidenceRef.current;
		if (stated === null) {
			setConfidenceMissing(true);
			return;
		}
		thinkingRef.current = "";
		setThinking("");
		const photos = tray.take();
		trayCount.current = 0;
		clearConfidence();
		onSubmit(text, stated, photos);
	};

	/* ENTER SUBMITS FROM ANYWHERE (owner round 6, 2026-10-05): dictation
	 * means the field is often never focused — the window-level Enter
	 * (typing surfaces and buttons excluded) submits the trace. Mounted
	 * while the dock is — collapsed bar included (the trace survives). */
	useEnterSubmits(submit);

	/* ── the collapsed bar ── */
	if (!expanded) {
		return (
			<button
				type="button"
				data-testid="practice-dock-bar"
				onClick={onExpand}
				className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon className="size-4 shrink-0 rotate-90" />
				<span className="font-medium">{t("session.practice.problem")}</span>
				<span className="min-w-0 flex-1 truncate">{input.statement}</span>
			</button>
		);
	}

	/* ── the expanded form ── */
	return (
		<div data-testid="practice-dock" data-problem={problemCallId}>
			{/* The agent's half: the 'Problem' eyebrow (mirroring the quiz
			    cards' label row — owner round, 2026-10-05) + the statement,
			    markdown + LaTeX rendered, capped by the measured column
			    (--dock-max-h; the old fixed 40vh cut long problems short). */}
			<div data-dock-scroll-area="" className="max-h-[var(--dock-max-h,40vh)] overflow-y-auto px-4 pt-3 pb-2">
				<div className="mb-1 text-xs font-medium text-muted-foreground">{t("session.practice.problem")}</div>
				<div className="np-prose text-[15px]">
					<ToolContentResponse>{input.statement}</ToolContentResponse>
				</div>
			</div>

			{/* Confidence (owner, 2026-11-05): how sure the learner is that
			    this submission is right — the review and exam models read it. */}
			<div className="border-t border-border/60 px-4 py-2.5">
				<ConfidenceSlider
					value={confidence}
					onChange={(stop) => {
						confidenceRef.current = stop;
						setConfidence(stop);
						setConfidenceMissing(false);
					}}
					label={t("session.question.confidence")}
					missingLabel={t("session.question.confidenceMissing")}
					missing={confidenceMissing}
					ariaLabel={t("session.question.confidenceAria")}
					valueText={confidence === null ? "—" : t("session.question.confidenceValue", { n: confidence })}
				/>
			</div>

			{/* The learner's half: Enter SENDS (owner round 2, 2026-10-05);
			    Shift+Enter makes a newline — less to decide about. */}
			<div
				data-testid="practice-thinking-field"
				className="m-1.5 rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50"
				{...tray.dropProps}
			>
				<div className="px-2.5 pt-2 text-xs font-medium text-muted-foreground">
					{t("session.yourThinking")}
				</div>
				<AttachmentTrayView tray={tray} />
				<textarea
					onPaste={tray.onPaste}
					value={thinking}
					onChange={(e) => {
						thinkingRef.current = e.target.value;
						setThinking(e.target.value);
						clearConfidence();
					}}
					onKeyDown={(e) => {
						// Esc ends dictation — stopPropagation claims it (the
						// keyboard machine) so the window chain doesn't also fire.
						if (e.key === "Escape" && onEscape) {
							e.preventDefault();
							e.stopPropagation();
							onEscape();
							return;
						}
						// Enter SENDS — the single lane (owner round 2, 2026-10-05);
						// Shift+Enter is the newline, ⌘/Ctrl+Enter the chord too.
						if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							submit();
						}
					}}
					placeholder={t("session.practice.placeholder")}
					rows={4}
					className={cn(
						"field-sizing-content np-input max-h-64 min-h-16 w-full resize-none bg-transparent px-2.5 pb-2 outline-none placeholder:text-muted-foreground",
					)}
				/>
				{/* The submit row (owner round 4, 2026-10-05): IDENTICAL to the
				    question dock's — hint left, the SAME Button (h-9, px-3.5),
				    one p-1 row. Corner radii concentric: shell 16 − m-1.5 (6) =
				    field 10 − p-1 (4) = button 6. */}
				<div className="flex items-center justify-between gap-2 p-1">
					<AttachButton tray={tray} className="size-9 rounded-[6px]" />
					<span aria-hidden className="mr-auto pl-1.5 text-xs text-muted-foreground">
						{compactionRunning ? t("session.composer.compacting") : t("session.composer.submitHint")}
					</span>
					<Button
						type="button"
						data-testid="practice-send"
						disabled={(thinking.trim().length === 0 && tray.count === 0) || tray.uploading || compactionRunning}
						onClick={() => submit()}
						className="ml-auto h-9 rounded-[6px] px-3.5 text-sm font-medium"
					>
						{t("session.practice.submit")}
					</Button>
				</div>
			</div>
		</div>
	);
}
