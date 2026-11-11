/**
 * Settings → «Conexión MCP» (owner, 2026-11-08): what the user pastes into
 * an MCP client to reach Naipes — pure, browser-safe. The command comes
 * from the desktop shell (electron/main.cjs `np:mcp:command`).
 */

import { MCP_TOKEN_ENV } from "./mcp-api.ts";

export const MCP_SERVER_KEY = "naipes";

export interface McpLaunch {
	command: string;
	args: string[];
	/** Environment the client must set (perf, owner 2026-11-10: the desktop
	 *  launch runs the app binary as plain Node — ELECTRON_RUN_AS_NODE — so
	 *  an MCP client no longer boots a whole Chromium, ~590 MB each). */
	env?: Record<string, string>;
}

/** One shell word: POSIX single quotes, or Windows double quotes. */
export function shellQuote(word: string, platform: string): string {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(word)) return word;
	if (platform === "win32") return `"${word.replace(/"/g, '\\"')}"`;
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Claude Code: registered for the user (every project), launched over
 *  stdio. With a token (Conexión MCP on) the server may also write. The
 *  name comes BEFORE `-e`: that option is variadic and would swallow it. */
export function claudeCodeCommand(launch: McpLaunch, platform: string, token: string | null = null): string {
	const vars = { ...launch.env, ...(token ? { [MCP_TOKEN_ENV]: token } : {}) };
	const env = Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
	return ["claude", "mcp", "add", "--scope", "user", MCP_SERVER_KEY, ...env, "--", launch.command, ...launch.args].map((w) => shellQuote(w, platform)).join(" ");
}

/** Claude Desktop (and most MCP clients): the `mcpServers` JSON entry. */
export function mcpServersJson(launch: McpLaunch, token: string | null = null): string {
	const vars = { ...launch.env, ...(token ? { [MCP_TOKEN_ENV]: token } : {}) };
	const entry = { command: launch.command, args: launch.args, ...(Object.keys(vars).length > 0 ? { env: vars } : {}) };
	return JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entry } }, null, 2);
}
