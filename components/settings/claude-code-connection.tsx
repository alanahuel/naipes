"use client";
import { useEffect, useRef, useState } from "react";
import { CLAUDE_CODE_LABEL, type ClaudeCodeAction, type ClaudeCodeStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ConnectionDialog, ConnectionFooter, ConnectionRow } from "./connection-controls";
import { Toggle } from "./controls";
import { translator, useT } from "@/components/i18n";

const en = translator("en");

const PATH = "/api/claude-code";
const HEADERS = { "Content-Type": "application/json", "x-naipes-subscriptions": "1" };
export const CLAUDE_CODE_NOTICE = en("settings.claudeCode.notice");

async function request(action?: ClaudeCodeAction, fields: Record<string, unknown> = {}, fallback = en("settings.claudeCode.changeError")): Promise<ClaudeCodeStatus> {
	const response = action
		? await fetch(PATH, { method: "POST", headers: HEADERS, body: JSON.stringify({ action, ...fields }) })
		: await fetch(PATH, { headers: HEADERS, cache: "no-store" });
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : fallback);
	return body as ClaudeCodeStatus;
}

export function ClaudeCodeConnection({ labelClassName }: { labelClassName?: string }) {
	const t = useT();
	const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
	const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [waiting, setWaiting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(true), poll = useRef<ReturnType<typeof setInterval> | null>(null);

	function accept(next: ClaudeCodeStatus) {
		if (!mounted.current) return;
		setStatus((previous) => {
			if (previous && (previous.connected !== next.connected || previous.email !== next.email)) notifySettingsSaved("keys");
			return next;
		});
	}
	function stopPolling() { if (poll.current) clearInterval(poll.current); poll.current = null; if (mounted.current) setWaiting(false); }
	useEffect(() => {
		mounted.current = true;
		void request().then(accept).catch(() => undefined);
		return () => { mounted.current = false; stopPolling(); };
	}, []);

	async function run(action: ClaudeCodeAction, fields?: Record<string, unknown>) {
		setBusy(true); setError(null);
		try { accept(await request(action, fields, t("settings.claudeCode.changeError"))); }
		catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : String(err)); }
		finally { if (mounted.current) setBusy(false); }
	}
	async function signIn() {
		await run("login");
		// The sign-in happens in Claude Code's own terminal window: watch for it for up to 3 minutes.
		stopPolling(); setWaiting(true);
		const started = Date.now();
		poll.current = setInterval(() => {
			void request().then((next) => { accept(next); if (next.connected || Date.now() - started > 180000) stopPolling(); }).catch(() => undefined);
		}, 3000);
	}

	const connected = status?.connected === true;
	const summary = !status ? t("settings.claudeCode.checking") : !status.installed ? t("settings.claudeCode.notInstalled") : connected ? `${status.plan ? t("settings.claudeCode.plan", { plan: `${status.plan[0]!.toUpperCase()}${status.plan.slice(1)}` }) : t("settings.claudeCode.connected")}${status.email ? ` · ${status.email}` : ""}` : t("settings.claudeCode.notSignedIn");
	return <div className="flex flex-col gap-2" data-testid="claude-code-connection">
		<ConnectionRow label={CLAUDE_CODE_LABEL} labelClassName={labelClassName} action={connected ? t("settings.connection.manage") : t("settings.connection.connect")} primary={!connected} disabled={busy} onAction={() => { setError(null); setOpen(true); void request().then(accept).catch(() => undefined); }}>
			<span className="font-ui text-xs text-muted-foreground" data-testid="claude-code-summary">{summary}</span>
		</ConnectionRow>
		{status?.error && <p role="alert" className="text-xs text-warn">{status.error}</p>}
		{open && <ConnectionDialog label={t("settings.connection.dialogLabel", { name: CLAUDE_CODE_LABEL })} testid="claude-code-dialog" backdropTestid="claude-code-dialog-backdrop" busy={busy} onClose={() => { if (!busy) { stopPolling(); setOpen(false); } }}>
			<h2 className="text-sm font-semibold text-foreground">{t("settings.claudeCode.title", { name: CLAUDE_CODE_LABEL })}</h2>
			<p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t("settings.claudeCode.notice")}</p>
			<p className="mt-3 text-xs text-foreground" role="status">{t("settings.claudeCode.status", { summary })}</p>
			{status && !status.installed && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("settings.claudeCode.installHint")}</p>}
			{waiting && !connected && <p className="mt-2 text-xs text-muted-foreground" role="status">{t("settings.claudeCode.waiting")}</p>}
			{connected && <div className="mt-4 flex items-center gap-3 text-xs text-foreground">
				<Toggle label={t("settings.connection.allowBackground")} testid="toggle-allow-background-use" checked={status.allowBackgroundUse} disabled={busy} onChange={(enabled) => void run("consent", { enabled })} />
				<span>{t("settings.connection.allowBackground")}<span className="mt-1 block leading-relaxed text-muted-foreground">{t("settings.connection.backgroundHint")}</span></span>
			</div>}
			{error && <p role="alert" className="mt-3 text-xs text-warn">{error}</p>}
			<ConnectionFooter testid="claude-code-dialog-footer" leading={connected && <Button variant="ghost" size="sm" className="cursor-pointer text-warn hover:bg-warn/10 hover:text-warn" disabled={busy} onClick={() => void run("logout")}>{t("settings.claudeCode.signOut")}</Button>}>
				<Button variant="ghost" size="sm" disabled={busy} onClick={() => void run("refresh")}>{t("settings.claudeCode.checkAgain")}</Button>
				{status?.installed && !connected && <Button variant="outline" size="sm" disabled={busy} onClick={() => void signIn()}>{t("settings.claudeCode.signIn")}</Button>}
				<Button variant="outline" size="sm" disabled={busy} onClick={() => { stopPolling(); setOpen(false); }}>{t("common.close")}</Button>
			</ConnectionFooter>
		</ConnectionDialog>}
	</div>;
}
