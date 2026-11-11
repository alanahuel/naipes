/** Settings → «Conexión MCP»: the pasted client setup (owner, 2026-11-08). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeCodeCommand, mcpServersJson, shellQuote } from "../src/core/mcp-config.ts";
import { MCP_TOKEN_ENV } from "../src/core/mcp-api.ts";

describe("MCP client setup", () => {
	it("Claude Code: user scope, stdio launch of `naipes --mcp`", () => {
		assert.equal(
			claudeCodeCommand({ command: "/home/ana/.local/opt/Naipes/Naipes.AppImage", args: ["--mcp"] }, "linux"),
			"claude mcp add --scope user naipes -- /home/ana/.local/opt/Naipes/Naipes.AppImage --mcp",
		);
	});

	it("with a token: the env rides after the name (-e is variadic) and in the JSON", () => {
		const launch = { command: "/opt/Naipes/naipes", args: ["--mcp"] };
		assert.equal(claudeCodeCommand(launch, "linux", "tok_123"), "claude mcp add --scope user naipes -e NAIPES_MCP_TOKEN=tok_123 -- /opt/Naipes/naipes --mcp");
		assert.deepEqual(JSON.parse(mcpServersJson(launch, "tok_123")).mcpServers.naipes.env, { NAIPES_MCP_TOKEN: "tok_123" });
		assert.equal("env" in JSON.parse(mcpServersJson(launch)).mcpServers.naipes, false);
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

it("a plain-Node launch carries its env into both outputs (perf, 2026-11-10); the token joins it", () => {
	const launch = { command: "/opt/Naipes.AppImage", args: ["-e", 'import("x")'], env: { ELECTRON_RUN_AS_NODE: "1", NP_DATA_DIR: "/d" } };
	const json = JSON.parse(mcpServersJson(launch, "tok")).mcpServers.naipes;
	assert.deepEqual(json.env, { ELECTRON_RUN_AS_NODE: "1", NP_DATA_DIR: "/d", [MCP_TOKEN_ENV]: "tok" });
	assert.deepEqual(json.args, ["-e", 'import("x")']);
	const cli = claudeCodeCommand(launch, "linux", "tok");
	assert.match(cli, /^claude mcp add --scope user naipes -e ELECTRON_RUN_AS_NODE=1 -e NP_DATA_DIR=\/d -e NAIPES_MCP_TOKEN=tok -- \/opt\/Naipes\.AppImage -e 'import\("x"\)'$/);
	assert.equal(JSON.parse(mcpServersJson({ command: "c", args: [] })).mcpServers.naipes.env, undefined, "no env → no env key");
});
