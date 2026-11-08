"use client";
/**
 * Settings → Connections → «Conexión MCP» (owner, 2026-11-08): the switch
 * for the local write API (off by default), its port and status, the token
 * («Regenerar»), and the ready-to-paste setup for Claude Code and for
 * Claude Desktop / other MCP clients — with the token while writing is on.
 * The launch command comes from the desktop shell (`naipes --mcp`); outside
 * the packaged app there is none, and the block says how to run it from the
 * repository instead.
 */
import { useCallback, useEffect, useState } from "react";
import { claudeCodeCommand, MCP_API_DEFAULT_PORT, MCP_PORT_MAX, MCP_PORT_MIN, mcpServersJson, type McpLaunch, type McpSettings } from "@/src/core";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n";
import { copyText } from "@/components/md-blocks";
import { onSettingsSaved } from "@/components/settings-signal";
import { CommitInput, SettingsRow, Toggle } from "./controls.tsx";
import { parseIntField } from "./review-section.tsx";

interface McpStatus {
	enabled: boolean;
	port: number;
	listening: boolean;
	error: string | null;
	token: string | null;
}

function Snippet({ label, hint, text, testid }: { label: string; hint: string; text: string; testid: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<div data-testid={testid} className="flex flex-col gap-1.5">
			<div className="flex items-end justify-between gap-3">
				<span className="min-w-0">
					<span className="block font-prose text-(length:--np-prose-size)">{label}</span>
					<span className="block text-xs text-muted-foreground/70">{hint}</span>
				</span>
				<Button variant="outline" size="sm" data-testid={`${testid}-copy`} onClick={() => void copyText(text).then(setCopied)}>
					{copied ? t("settings.mcp.copied") : t("settings.mcp.copy")}
				</Button>
			</div>
			<pre className="overflow-x-auto rounded-sm border border-border bg-muted/40 px-2.5 py-2 font-mono text-xs text-foreground select-text">{text}</pre>
		</div>
	);
}

export function McpSection({ mcp, onChange }: { mcp: McpSettings | undefined; onChange: (next: McpSettings) => Promise<void> | void }) {
	const t = useT();
	// undefined = asking the shell; null = no packaged app (browser / checkout).
	const [launch, setLaunch] = useState<McpLaunch | null | undefined>(undefined);
	const [platform, setPlatform] = useState("linux");
	const [status, setStatus] = useState<McpStatus | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		const res = await fetch("/api/mcp", { cache: "no-store" }).catch(() => null);
		if (res?.ok) setStatus((await res.json()) as McpStatus);
	}, []);

	useEffect(() => {
		setPlatform(window.np?.platform ?? "linux");
		void refresh();
		const off = onSettingsSaved((section) => section === "mcp" && void refresh());
		const ask = window.np?.mcpCommand;
		if (!ask) {
			setLaunch(null);
			return off;
		}
		let live = true;
		void ask().then((next) => live && setLaunch(next)).catch(() => live && setLaunch(null));
		return () => {
			live = false;
			off();
		};
	}, [refresh]);

	const enabled = mcp?.enabled === true;
	const port = mcp?.port ?? MCP_API_DEFAULT_PORT;
	const token = enabled ? (status?.token ?? null) : null;

	async function regenerate() {
		setBusy(true);
		try {
			const res = await fetch("/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "regenerate" }) });
			if (res.ok) setStatus((await res.json()) as McpStatus);
		} finally {
			setBusy(false);
		}
	}

	const state = !enabled || !status ? null : status.listening ? t("settings.mcp.listening", { port: status.port }) : status.error === "port_in_use" ? t("settings.mcp.portInUse", { port: status.port }) : status.error ? t("settings.mcp.listenError", { port: status.port, error: status.error }) : null;

	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-muted-foreground">{t("settings.mcp.intro")}</p>
			<SettingsRow label={t("settings.mcp.write")} hint={t("settings.mcp.writeHint")}>
				<Toggle checked={enabled} label={t("settings.mcp.write")} testid="mcp-enabled" onChange={(on) => void onChange({ ...mcp, enabled: on })} />
			</SettingsRow>
			{enabled && (
				<>
					<SettingsRow label={t("settings.mcp.port")} hint={state ?? undefined} testid="mcp-port-row">
						<CommitInput
							type="number"
							value={String(port)}
							ariaLabel={t("settings.mcp.port")}
							testid="mcp-port"
							onCommit={(raw) => {
								const n = parseIntField(raw, MCP_PORT_MIN, MCP_PORT_MAX);
								if (n !== null && n !== port) void onChange({ ...mcp, port: n });
							}}
						/>
					</SettingsRow>
					<SettingsRow label={t("settings.mcp.regenerate")} hint={t("settings.mcp.regenerateHint")}>
						<Button variant="outline" size="sm" disabled={busy} data-testid="mcp-regenerate" onClick={() => void regenerate()}>
							{t("settings.mcp.regenerate")}
						</Button>
					</SettingsRow>
				</>
			)}
			{launch === null && (
				<p data-testid="mcp-unavailable" className="text-sm text-muted-foreground">
					{t("settings.mcp.unavailable")}
				</p>
			)}
			{launch && (!enabled || token) && (
				<>
					<Snippet testid="mcp-claude-code" label={t("settings.mcp.claudeCode")} hint={t("settings.mcp.claudeCodeHint")} text={claudeCodeCommand(launch, platform, token)} />
					<Snippet testid="mcp-desktop" label={t("settings.mcp.desktop")} hint={t("settings.mcp.desktopHint")} text={mcpServersJson(launch, token)} />
				</>
			)}
		</div>
	);
}
