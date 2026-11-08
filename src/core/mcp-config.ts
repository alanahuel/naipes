/**
 * Settings → «Conexión MCP» (owner, 2026-11-08): what the user pastes into
 * an MCP client to reach Naipes — pure, browser-safe. The command comes
 * from the desktop shell (electron/main.cjs `np:mcp:command`).
 */

export const MCP_SERVER_KEY = "naipes";

export interface McpLaunch {
	command: string;
	args: string[];
}

/** One shell word: POSIX single quotes, or Windows double quotes. */
export function shellQuote(word: string, platform: string): string {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(word)) return word;
	if (platform === "win32") return `"${word.replace(/"/g, '\\"')}"`;
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Claude Code: registered for the user (every project), launched over stdio. */
export function claudeCodeCommand(launch: McpLaunch, platform: string): string {
	return ["claude", "mcp", "add", "--scope", "user", MCP_SERVER_KEY, "--", launch.command, ...launch.args].map((w) => shellQuote(w, platform)).join(" ");
}

/** Claude Desktop (and most MCP clients): the `mcpServers` JSON entry. */
export function mcpServersJson(launch: McpLaunch): string {
	return JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { command: launch.command, args: launch.args } } }, null, 2);
}
