"use client";
/**
 * The confirmation an MCP client's deletion waits for (owner, 2026-11-08 —
 * MCP phase 3): whatever page is open, the oldest pending request shows as
 * a dialog in the session-deletion dialog's shape. Nothing is deleted
 * without «Eliminar» here; «Rechazar», Esc or the backdrop reject. For a
 * session the graph-traces checkbox starts at the model's suggestion and
 * the learner decides. A failed deletion (work still running…) keeps the
 * request: its reason shows, and «Eliminar» tries again.
 *
 * Refetches on the `mcp-deletion` event and on every events (re)connect —
 * a window opened from the system notification finds the request at once.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { McpDeletionView, MessageKey } from "@/src/core";
import { useT } from "@/components/i18n";
import { useServerEvent, useServerResync } from "@/components/server-events";

export function McpDeletionHost() {
	const [requests, setRequests] = useState<McpDeletionView[]>([]);
	const refresh = useCallback(() => {
		void fetch("/api/mcp/deletions", { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : null))
			.then((body: { requests?: McpDeletionView[] } | null) => body?.requests && setRequests(body.requests))
			.catch(() => undefined);
	}, []);
	useEffect(refresh, [refresh]);
	useServerEvent("mcp-deletion", refresh);
	useServerResync(refresh);
	const current = requests[0];
	if (!current) return null;
	return <McpDeletionDialog key={current.id} request={current} waiting={requests.length - 1} onSettled={refresh} />;
}

function McpDeletionDialog({ request, waiting, onSettled }: { request: McpDeletionView; waiting: number; onSettled: () => void }) {
	const t = useT();
	const [traces, setTraces] = useState(request.suggestTraces);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const answer = useCallback(
		async (decision: "delete" | "reject") => {
			setBusy(true);
			setFailure(null);
			try {
				const res = await fetch(`/api/mcp/deletions/${encodeURIComponent(request.id)}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ decision, removeGraphTraces: traces }),
				});
				if (!res.ok && res.status !== 404) {
					const body = (await res.json().catch(() => ({}))) as { error?: string };
					setFailure(body.error ?? t("mcp.deletion.failed", { status: res.status }));
					return;
				}
				onSettled();
			} catch {
				setFailure(t("mcp.deletion.failed", { status: "—" }));
			} finally {
				setBusy(false);
			}
		},
		[request.id, traces, onSettled, t],
	);

	// Esc rejects (claimed at the document level — the one-Esc law).
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			if (!busy) void answer("reject");
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [answer, busy]);

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
			<McpDeletionBody request={request} waiting={waiting} traces={traces} busy={busy} failure={failure} onTraces={setTraces} onReject={() => void answer("reject")} onDelete={() => void answer("delete")} />
		</div>,
		document.body,
	);
}

/** The dialog's pure body — exported for SSR pins. */
export function McpDeletionBody({
	request,
	waiting,
	traces,
	busy,
	failure,
	onTraces,
	onReject,
	onDelete,
}: {
	request: McpDeletionView;
	waiting: number;
	traces: boolean;
	busy: boolean;
	failure: string | null;
	onTraces: (next: boolean) => void;
	onReject: () => void;
	onDelete: () => void;
}) {
	const t = useT();
	const body: MessageKey = request.kind === "session" ? "session.delete.body" : request.kind === "exam" ? "mcp.deletion.body.exam" : "mcp.deletion.body.proposition";
	return (
		<div role="alertdialog" aria-modal="true" aria-label={t("mcp.deletion.aria")} data-testid="mcp-deletion-dialog" className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl">
			<h2 className="text-sm font-semibold text-destructive">{t(`mcp.deletion.title.${request.kind}` as MessageKey, { client: request.client })}</h2>
			<div className="mt-1.5">
				<code data-testid="mcp-deletion-label" className="font-mono text-sm text-foreground">
					{request.label}
				</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">{t(body)}</p>
			{request.kind === "session" && (
				<label data-testid="mcp-deletion-traces" className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3">
					<input type="checkbox" checked={traces} onChange={(e) => onTraces(e.target.checked)} disabled={busy} className="mt-0.5 size-4 shrink-0 accent-primary" data-testid="mcp-deletion-traces-checkbox" />
					<span className="min-w-0">
						<span className="block text-sm text-foreground">{t("session.delete.tracesTitle")}</span>
						<span className="mt-1 block text-xs text-muted-foreground">{t("session.delete.tracesBody")}</span>
					</span>
				</label>
			)}
			{failure && (
				<p role="alert" data-testid="mcp-deletion-failure" className="mt-3 text-sm text-warn">
					{failure}
				</p>
			)}
			{waiting > 0 && <p className="mt-3 text-xs text-muted-foreground">{t("mcp.deletion.more", { n: waiting })}</p>}
			{/* The app's established destructive pair (delete-session-dialog). */}
			<div className="mt-4 flex justify-end gap-2">
				<button type="button" data-testid="mcp-deletion-reject" disabled={busy} onClick={onReject} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">
					{t("mcp.deletion.reject")}
				</button>
				<button type="button" data-testid="mcp-deletion-confirm" disabled={busy} onClick={onDelete} className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40">
					{busy ? t("session.delete.deleting") : t("session.delete.confirm")}
				</button>
			</div>
		</div>
	);
}
