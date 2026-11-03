/**
 * Claude Code subscription connection — server-side state (personal use).
 *
 * Naipes never reads or stores Claude credentials. It drives the
 * user's own installed `claude` CLI, which owns sign-in (`claude auth
 * login`), and reads `claude auth status --json` to know whether a
 * claude.ai subscription session exists. The only state persisted here is
 * the "allow background use" consent (PATHS.data/claude-code.json).
 */
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { CLAUDE_CODE_MODEL_IDS, CLAUDE_CODE_PROVIDER, type ClaudeCodeStatus } from "../core/contracts/claude-code.ts";
import { piModels } from "./models.ts";
import type { AdmissionScope, NoDispatchKind } from "./subscription-request-cycle.ts";

const execFileP = promisify(execFile);
const isWindows = process.platform === "win32";
const REFRESH_TTL_MS = 5000;

interface State {
	status: ClaudeCodeStatus;
	/** Bumped whenever the signed-in account changes; in-flight work is cancelled. */
	epoch: number;
	accountId: string | null;
	checkedAt: number;
	inflight: Promise<ClaudeCodeStatus> | null;
	binary: string | null;
	listeners: Set<() => void>;
	controllers: Map<AbortController, boolean>;
}
const key = Symbol.for("np.claude-code.bridge");
function state(): State {
	const g = globalThis as typeof globalThis & { [key]?: State };
	g[key] ??= {
		status: { installed: false, connected: false, email: null, plan: null, allowBackgroundUse: readConsent(), error: null },
		epoch: 0, accountId: null, checkedAt: 0, inflight: null, binary: null, listeners: new Set(), controllers: new Map(),
	};
	return g[key];
}
function notify(s: State) { for (const listener of s.listeners) listener(); }

// ─── consent persistence ─────────────────────────────────────────────────────
function consentFile(): string { return path.join(PATHS.data, "claude-code.json"); }
function readConsent(): boolean {
	try { return JSON.parse(readFileSync(consentFile(), "utf8")).allowBackgroundUse !== false; } catch { return true; }
}
export function setClaudeCodeBackgroundUse(enabled: boolean): void {
	mkdirSync(PATHS.data, { recursive: true });
	writeFileSync(consentFile(), JSON.stringify({ allowBackgroundUse: enabled }, null, "\t") + "\n");
	const s = state();
	s.status = { ...s.status, allowBackgroundUse: enabled };
	if (!enabled) for (const [controller, background] of s.controllers) if (background) controller.abort("background");
	notify(s);
}

// ─── locating the CLI ────────────────────────────────────────────────────────
/** PATH first, then the native installer's ~/.local/bin (packaged desktop
 *  servers often start without the user's shell PATH). */
export async function findClaudeBinary(): Promise<string | null> {
	const s = state();
	if (s.binary && existsSync(s.binary)) return s.binary;
	const candidates: string[] = [];
	if (process.env.NP_CLAUDE_BIN) candidates.push(process.env.NP_CLAUDE_BIN);
	try {
		const { stdout } = await execFileP(isWindows ? "where" : "which", ["claude"], { windowsHide: true });
		candidates.push(...stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
	} catch { /* not on PATH */ }
	const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
	candidates.push(path.join(home, ".local", "bin", isWindows ? "claude.exe" : "claude"));
	if (!isWindows) candidates.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude");
	for (const candidate of candidates) {
		if (isWindows && !/\.exe$/i.test(candidate)) {
			const exe = path.join(path.dirname(candidate), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
			if (existsSync(exe)) return (s.binary = exe);
			continue;
		}
		if (existsSync(candidate)) return (s.binary = candidate);
	}
	return null;
}

// ─── status ──────────────────────────────────────────────────────────────────
interface AuthStatus { loggedIn?: boolean; authMethod?: string; email?: string; orgId?: string; subscriptionType?: string }
async function readAuthStatus(binary: string): Promise<AuthStatus> {
	try {
		const { stdout } = await execFileP(binary, ["auth", "status", "--json"], { timeout: 20000, windowsHide: true, env: claudeCodeEnv() });
		return JSON.parse(stdout) as AuthStatus;
	} catch (error) {
		// `auth status` exits non-zero when signed out but still prints JSON.
		const stdout = (error as { stdout?: string }).stdout;
		if (stdout) return JSON.parse(stdout) as AuthStatus;
		throw error;
	}
}

/** Re-read the CLI's sign-in state (deduplicated, cached for a few seconds unless forced). */
export async function refreshClaudeCodeStatus(force = false): Promise<ClaudeCodeStatus> {
	const s = state();
	if (!force && Date.now() - s.checkedAt < REFRESH_TTL_MS) return s.status;
	if (s.inflight) return s.inflight;
	s.inflight = (async () => {
		const allowBackgroundUse = readConsent();
		let next: ClaudeCodeStatus;
		let accountId: string | null = null;
		const binary = await findClaudeBinary();
		if (!binary) next = { installed: false, connected: false, email: null, plan: null, allowBackgroundUse, error: null };
		else {
			try {
				const auth = await readAuthStatus(binary);
				// Only a claude.ai (subscription) sign-in counts: an API-key
				// login would bill per use, which this connection never does.
				const connected = auth.loggedIn === true && auth.authMethod === "claude.ai";
				accountId = connected ? `${auth.orgId ?? ""}:${auth.email ?? ""}` : null;
				next = {
					installed: true, connected, email: connected ? auth.email ?? null : null, plan: connected ? auth.subscriptionType ?? null : null, allowBackgroundUse,
					error: auth.loggedIn && !connected ? "Claude Code is signed in with an API key, not a Claude subscription. Sign in again with your Claude account." : null,
				};
			} catch {
				next = { installed: true, connected: false, email: null, plan: null, allowBackgroundUse, error: "Could not read the Claude Code sign-in status." };
			}
		}
		const changed = JSON.stringify(next) !== JSON.stringify(s.status) || accountId !== s.accountId;
		if (accountId !== s.accountId) {
			s.epoch++;
			for (const controller of s.controllers.keys()) controller.abort("all");
		}
		s.status = next; s.accountId = accountId; s.checkedAt = Date.now();
		if (changed) notify(s);
		return next;
	})().finally(() => { s.inflight = null; });
	return s.inflight;
}

export function claudeCodeStatus(): ClaudeCodeStatus { return state().status; }
export function claudeCodeConnected(): boolean { return state().status.connected; }
export function claudeCodeBackgroundAllowed(): boolean { const s = state().status; return s.connected && s.allowBackgroundUse; }
export function onClaudeCodeChange(listener: () => void): () => void { state().listeners.add(listener); return () => { state().listeners.delete(listener); }; }

// ─── catalog ─────────────────────────────────────────────────────────────────
/** Anthropic's catalog entries re-homed under the claude-code provider:
 *  zero cost (the subscription is not billed per use) and only the effort
 *  levels Claude Code's --effort accepts (low…max). */
export function claudeCodeModels(): Model<Api>[] {
	if (!claudeCodeConnected()) return [];
	return CLAUDE_CODE_MODEL_IDS.flatMap((id) => {
		const base = piModels().getModel("anthropic", id);
		if (!base) return [];
		return [{
			...base,
			provider: CLAUDE_CODE_PROVIDER,
			headers: undefined,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			thinkingLevelMap: { ...base.thinkingLevelMap, off: null, minimal: null },
		} as Model<Api>];
	});
}
export function claudeCodeModel(id: string): Model<Api> | undefined { return claudeCodeModels().find((m) => m.id === id); }

// ─── admission (SubscriptionRequestCycle contract) ──────────────────────────
export function claudeCodeScope(selectedModelId: string): AdmissionScope {
	const s = state();
	if (!claudeCodeConnected() || !s.accountId || !claudeCodeModel(selectedModelId)) throw new Error("Claude Code model unavailable");
	return { accountId: s.accountId, epoch: s.epoch, authorityRevision: 0, selectedModelId };
}
export function claudeCodeScopeCurrent(scope: AdmissionScope): boolean {
	const s = state();
	return claudeCodeConnected() && scope.accountId === s.accountId && scope.epoch === s.epoch && !!claudeCodeModel(scope.selectedModelId);
}
export function claudeCodeAbortController(background: boolean): { controller: AbortController; release: () => void } {
	const s = state(), controller = new AbortController();
	s.controllers.set(controller, background);
	return { controller, release: () => { s.controllers.delete(controller); } };
}
export function claudeCodeDenial(scope: AdmissionScope | undefined, controller: AbortController, callerAborted: boolean, background: boolean): NoDispatchKind {
	if (callerAborted || controller.signal.reason === "all") return "all";
	if (!scope || !claudeCodeScopeCurrent(scope)) return "other";
	if (controller.signal.reason === "background" || (background && !claudeCodeBackgroundAllowed())) return "background";
	return "other";
}

// ─── process environment ─────────────────────────────────────────────────────
/** Never let an ambient key or gateway redirect billing away from the subscription. */
export function claudeCodeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete env[name];
	env.ENABLE_TOOL_SEARCH = "false"; // every Naipes tool must be visible up front
	env.DISABLE_AUTOUPDATER = "1";
	return env;
}

// ─── sign-in / sign-out (Anthropic's own CLI flow) ──────────────────────────
/** Open `claude auth login` in a terminal window: the sign-in is Claude Code's, never ours. */
export async function openClaudeCodeLogin(): Promise<boolean> {
	const binary = await findClaudeBinary();
	if (!binary) return false;
	if (isWindows) {
		spawn("cmd.exe", ["/c", "start", '""', binary, "auth", "login"], { detached: true, stdio: "ignore", windowsHide: false }).unref();
		return true;
	}
	const dir = path.join(PATHS.data, "claude-code");
	mkdirSync(dir, { recursive: true });
	const script = path.join(dir, "login.command");
	writeFileSync(script, `#!/bin/bash\nclear\n'${binary.replaceAll("'", "'\\''")}' auth login\necho\nread -p 'Done. Press Enter to close this window.' _\n`);
	chmodSync(script, 0o755);
	if (process.platform === "darwin") { spawn("open", ["-a", "Terminal", script], { detached: true, stdio: "ignore" }).unref(); return true; }
	const onPath = (bin: string) => (process.env.PATH || "").split(":").some((dir) => dir && existsSync(path.join(dir, bin)));
	const terminals = [process.env.TERMINAL, "ghostty", "kitty", "alacritty", "foot", "wezterm", "konsole", "gnome-terminal", "xfce4-terminal", "xterm"].filter((t): t is string => !!t);
	const terminal = terminals.find(onPath);
	if (!terminal) return false;
	const args = terminal === "gnome-terminal" ? ["--", "bash", script] : terminal === "wezterm" ? ["start", "--", "bash", script] : ["-e", "bash", script];
	spawn(terminal, args, { detached: true, stdio: "ignore" }).unref();
	return true;
}

export async function claudeCodeLogout(): Promise<void> {
	const binary = await findClaudeBinary();
	if (binary) await execFileP(binary, ["auth", "logout"], { timeout: 20000, windowsHide: true, env: claudeCodeEnv() }).catch(() => undefined);
	await refreshClaudeCodeStatus(true);
}

/** Test seam: reset the process-wide state. */
export function resetClaudeCodeBridgeForTests(): void {
	delete (globalThis as typeof globalThis & { [key]?: State })[key];
}
