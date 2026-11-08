/** Settings → «Conexión MCP»: the pasted client setup (owner, 2026-11-08). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeCodeCommand, mcpServersJson, shellQuote } from "../src/core/mcp-config.ts";

describe("MCP client setup", () => {
	it("Claude Code: user scope, stdio launch of `naipes --mcp`", () => {
		assert.equal(
			claudeCodeCommand({ command: "/home/ana/.local/opt/Naipes/Naipes.AppImage", args: ["--mcp"] }, "linux"),
			"claude mcp add --scope user naipes -- /home/ana/.local/opt/Naipes/Naipes.AppImage --mcp",
		);
	});

	it("quotes paths with spaces and quotes per platform", () => {
		assert.equal(shellQuote("/Applications/My Apps/Naipes", "darwin"), "'/Applications/My Apps/Naipes'");
		assert.equal(shellQuote("/tmp/it's", "linux"), `'/tmp/it'\\''s'`);
		assert.equal(shellQuote("C:\\Program Files\\Naipes\\Naipes.exe", "win32"), '"C:\\Program Files\\Naipes\\Naipes.exe"');
	});

	it("mcpServers JSON round-trips the exact command (Windows backslashes included)", () => {
		const launch = { command: "C:\\Program Files\\Naipes\\Naipes.exe", args: ["--mcp"] };
		assert.deepEqual(JSON.parse(mcpServersJson(launch)), { mcpServers: { naipes: launch } });
	});
});
