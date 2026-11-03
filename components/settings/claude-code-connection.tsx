"use client";
import { useEffect, useRef, useState } from "react";
import { CLAUDE_CODE_LABEL, type ClaudeCodeAction, type ClaudeCodeStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ConnectionDialog, ConnectionFooter, ConnectionRow } from "./connection-controls";
import { Toggle } from "./controls";

const PATH = "/api/claude-code";
const HEADERS = { "Content-Type": "application/json", "x-naipes-subscriptions": "1" };
export const CLAUDE_CODE_NOTICE = "Naipes runs your own installed Claude Code (`claude -p`) as the model, so your prompts, tool results and relevant session context are sent to Anthropic through Claude Code. Sign-in is handled entirely by Claude Code; Naipes never reads or stores your Claude credentials. Usage counts against your Claude plan limits. This connection never falls back to an API key. For personal use on this computer.";
const INSTALL_HINT = "Claude Code is not installed. Install it from claude.com/claude-code (for example `curl -fsSL https://claude.ai/install.sh | bash`), then check again.";

async function request(action?: ClaudeCodeAction, fields: Record<string, unknown> = {}): Promise<ClaudeCodeStatus> {
	const response = action
		? await fetch(PATH, { method: "POST", headers: HEADERS, body: JSON.stringify({ action, ...fields }) })
		: await fetch(PATH, { headers: HEADERS, cache: "no-store" });
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The Claude Code connection could not be changed.");
	return body as ClaudeCodeStatus;
}

export function ClaudeCodeConnection({ labelClassName }: { labelClassName?: string }) {
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
		try { accept(await request(action, fields)); }
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
	const summary = !status ? "Checking…" : !status.installed ? "Not installed" : connected ? `${status.plan ? `${status.plan[0]!.toUpperCase()}${status.plan.slice(1)} plan` : "Connected"}${status.email ? ` · ${status.email}` : ""}` : "Not signed in";
	return <div className="flex flex-col gap-2" data-testid="claude-code-connection">
		<ConnectionRow label={CLAUDE_CODE_LABEL} labelClassName={labelClassName} action={connected ? "Manage…" : "Connect"} disabled={busy} onAction={() => { setError(null); setOpen(true); void request().then(accept).catch(() => undefined); }}>
			<span className="font-ui text-xs text-muted-foreground" data-testid="claude-code-summary">{summary}</span>
		</ConnectionRow>
		{status?.error && <p role="alert" className="text-xs text-red-400">{status.error}</p>}
		{open && <ConnectionDialog label={`${CLAUDE_CODE_LABEL} connection`} testid="claude-code-dialog" backdropTestid="claude-code-dialog-backdrop" busy={busy} onClose={() => { if (!busy) { stopPolling(); setOpen(false); } }}>
			<h2 className="text-sm font-semibold text-foreground">{CLAUDE_CODE_LABEL} (Claude subscription)</h2>
			<p className="mt-3 text-xs leading-relaxed text-muted-foreground">{CLAUDE_CODE_NOTICE}</p>
			<p className="mt-3 text-xs text-foreground" role="status">Status: {summary}</p>
			{status && !status.installed && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{INSTALL_HINT}</p>}
			{waiting && !connected && <p className="mt-2 text-xs text-muted-foreground" role="status">Finish signing in in the Claude Code terminal window. This updates automatically.</p>}
			{connected && <div className="mt-4 flex items-center gap-3 text-xs text-foreground">
				<Toggle label="Allow background use" checked={status.allowBackgroundUse} disabled={busy} onChange={(enabled) => void run("consent", { enabled })} />
				<span>Allow background use<span className="mt-1 block leading-relaxed text-muted-foreground">Allow Naipes helper agents and automatic follow-ups to use this connection.</span></span>
			</div>}
			{error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
			<ConnectionFooter testid="claude-code-dialog-footer" leading={connected && <Button variant="ghost" size="sm" className="cursor-pointer text-red-400 hover:bg-red-500/10 hover:text-red-300" disabled={busy} onClick={() => void run("logout")}>Sign out of Claude Code</Button>}>
				<Button variant="ghost" size="sm" disabled={busy} onClick={() => void run("refresh")}>Check again</Button>
				{status?.installed && !connected && <Button variant="outline" size="sm" disabled={busy} onClick={() => void signIn()}>Sign in</Button>}
				<Button variant="outline" size="sm" disabled={busy} onClick={() => { stopPolling(); setOpen(false); }}>Close</Button>
			</ConnectionFooter>
		</ConnectionDialog>}
	</div>;
}
