"use client";
/**
 * Settings → Connections → «Conexión MCP» (owner, 2026-11-08): the ready-to-
 * paste setup for Claude Code and for Claude Desktop / other MCP clients.
 * The launch command comes from the desktop shell (`naipes --mcp`); outside
 * the packaged app there is none, and the row says how to run it from the
 * repository instead.
 */
import { useEffect, useState } from "react";
import { claudeCodeCommand, mcpServersJson, type McpLaunch } from "@/src/core";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n";
import { copyText } from "@/components/md-blocks";

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

export function McpSection() {
	const t = useT();
	// undefined = asking the shell; null = no packaged app (browser / checkout).
	const [launch, setLaunch] = useState<McpLaunch | null | undefined>(undefined);
	const [platform, setPlatform] = useState("linux");
	useEffect(() => {
		setPlatform(window.np?.platform ?? "linux");
		const ask = window.np?.mcpCommand;
		if (!ask) {
			setLaunch(null);
			return;
		}
		let live = true;
		void ask().then((next) => live && setLaunch(next)).catch(() => live && setLaunch(null));
		return () => {
			live = false;
		};
	}, []);
	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-muted-foreground">{t("settings.mcp.intro")}</p>
			{launch === null && (
				<p data-testid="mcp-unavailable" className="text-sm text-muted-foreground">
					{t("settings.mcp.unavailable")}
				</p>
			)}
			{launch && (
				<>
					<Snippet testid="mcp-claude-code" label={t("settings.mcp.claudeCode")} hint={t("settings.mcp.claudeCodeHint")} text={claudeCodeCommand(launch, platform)} />
					<Snippet testid="mcp-desktop" label={t("settings.mcp.desktop")} hint={t("settings.mcp.desktopHint")} text={mcpServersJson(launch)} />
				</>
			)}
		</div>
	);
}
