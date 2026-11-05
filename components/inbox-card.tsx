"use client";
/**
 * BANDEJA (knowledge folder phase 3, owner 2026-11-05): a floating card in
 * Conocimiento, bottom-left over the graph, listing the notes dropped in
 * the inbox folder and the folder the graph suggests for each —
 * «Mover» / «Descartar» / «Elegir otra…». Shown only while «Sugerir dónde
 * guardar» is on and the inbox holds something; collapsible.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, InboxIcon } from "lucide-react";
import { useServerEvent } from "@/components/server-events";
import { useT } from "@/components/i18n";

interface FolderCount {
	folder: string;
	count: number;
}

export interface InboxItemView {
	path: string;
	status: "suggested" | "none" | "pending" | "extracting" | "waiting";
	suggestion?: FolderCount & { total: number };
	alternatives: FolderCount[];
}

export interface InboxView {
	enabled: boolean;
	inbox: string | null;
	items: InboxItemView[];
	destinations: string[];
}

const nameOf = (p: string) => p.split("/").pop() ?? p;
const button = "rounded-sm border border-border px-2 py-0.5 hover:border-muted-foreground/50 disabled:opacity-50";
const quiet = "rounded-sm px-2 py-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50";

function InboxRow({ item, destinations, busy, act }: {
	item: InboxItemView;
	destinations: string[];
	busy: boolean;
	act: (body: { path: string; action: "move"; folder: string } | { path: string; action: "dismiss" }) => void;
}) {
	const t = useT();
	const [choosing, setChoosing] = useState(false);
	const [other, setOther] = useState("");
	const move = (folder: string) => act({ path: item.path, action: "move", folder });
	const status =
		item.status === "pending" ? t("inbox.pending")
		: item.status === "extracting" ? t("inbox.extracting")
		: item.status === "waiting" ? t("inbox.waiting")
		: item.status === "none" ? t("inbox.none")
		: null;
	return (
		<li className="flex flex-col gap-1 py-2" data-testid={`inbox-item-${item.path}`}>
			<span className="truncate text-sm text-foreground" title={item.path}>{nameOf(item.path)}</span>
			{item.suggestion ? (
				<span className="text-xs text-muted-foreground">
					{t("inbox.suggestion", { folder: item.suggestion.folder, count: item.suggestion.count, total: item.suggestion.total })}
				</span>
			) : (
				status && <span className="text-xs text-muted-foreground">{status}</span>
			)}
			{(item.status === "suggested" || item.status === "none") && (
				<div className="flex flex-wrap items-center gap-1.5 text-xs">
					{item.suggestion && (
						<>
							<button type="button" className={button} disabled={busy} onClick={() => move(item.suggestion!.folder)}>{t("inbox.move")}</button>
							<button type="button" className={quiet} disabled={busy} onClick={() => act({ path: item.path, action: "dismiss" })}>{t("inbox.dismiss")}</button>
						</>
					)}
					<button type="button" className={quiet} disabled={busy} onClick={() => setChoosing((v) => !v)}>
						{t(item.suggestion ? "inbox.chooseOther" : "inbox.choose")}
					</button>
				</div>
			)}
			{choosing && (
				<div className="flex flex-col gap-1.5 text-xs">
					{item.alternatives.map((alt) => (
						<button key={alt.folder} type="button" className={`${quiet} text-left`} disabled={busy} onClick={() => move(alt.folder)}>
							→ {t("inbox.alternative", { folder: alt.folder, count: alt.count })}
						</button>
					))}
					<span className="flex items-center gap-1.5">
						<select
							className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1"
							value={other}
							aria-label={t("inbox.otherFolder")}
							onChange={(e) => setOther(e.target.value)}
						>
							<option value="">{t("inbox.otherFolder")}</option>
							{destinations.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
						</select>
						<button type="button" className={button} disabled={busy || !other} onClick={() => move(other)}>{t("inbox.move")}</button>
					</span>
				</div>
			)}
		</li>
	);
}

export function InboxCard() {
	const t = useT();
	const [view, setView] = useState<InboxView | null>(null);
	const [open, setOpen] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/vault/inbox");
			if (res.ok) setView((await res.json()) as InboxView);
		} catch {
			// offline: keep the last view
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	// Extractions finishing and inbox notices both change what is shown.
	useServerEvent("activity-changed", () => void refresh());
	useServerEvent("vault-notice", () => void refresh());

	const act = async (body: { path: string; action: "move"; folder: string } | { path: string; action: "dismiss" }) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/vault/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
			void refresh();
		}
	};

	if (!view?.enabled || view.items.length === 0) return null;
	return (
		<div
			className="np-no-drag absolute bottom-3 left-3 z-10 w-80 max-w-[calc(100%-1.5rem)] rounded-xl border bg-card/95 shadow-lg backdrop-blur"
			data-testid="inbox-card"
		>
			<button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left">
				<InboxIcon className="size-4 text-muted-foreground" />
				<span className="flex-1 text-sm font-semibold">{t("inbox.title", { n: view.items.length })}</span>
				{open ? <ChevronDownIcon className="size-4 text-muted-foreground" /> : <ChevronUpIcon className="size-4 text-muted-foreground" />}
			</button>
			{open && (
				<div className="max-h-80 overflow-y-auto border-t px-3">
					<ul className="divide-y">
						{view.items.map((item) => (
							<InboxRow key={item.path} item={item} destinations={view.destinations} busy={busy} act={(body) => void act(body)} />
						))}
					</ul>
					{error && <p role="alert" className="pb-2 text-xs text-warn">{error}</p>}
				</div>
			)}
		</div>
	);
}
