import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSupportedThinkingLevels, normalizeContext, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// A scratch data dir and a fake `claude` CLI — no network, no real account.
const dir = mkdtempSync(path.join(os.tmpdir(), "np-claude-code-test-"));
process.env.NP_DATA_DIR = path.join(dir, "data");
const fake = path.join(dir, "claude");
const control = path.join(dir, "control.json");
const record = path.join(dir, "record.json");
writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const c = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") { process.stdout.write(JSON.stringify(c.auth)); process.exit(c.auth.loggedIn ? 0 : 1); }
let input = "";
process.stdin.on("data", (d) => input += d).on("end", () => {
	fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, input, apiKey: process.env.ANTHROPIC_API_KEY ?? null, toolSearch: process.env.ENABLE_TOOL_SEARCH }));
	if (c.hang) { setInterval(() => {}, 1000); return; }
	for (const line of c.lines) process.stdout.write(JSON.stringify(line) + "\\n");
	if (c.keepAlive) setInterval(() => {}, 1000);
});
`);
chmodSync(fake, 0o755);
process.env.NP_CLAUDE_BIN = fake;

type Bridge = typeof import("../src/agent/claude-code-bridge.ts");
type Stream = typeof import("../src/agent/claude-code-stream.ts");
let bridge: Bridge, stream: Stream;
const originalKey = process.env.ANTHROPIC_API_KEY;
const SUBSCRIPTION = { loggedIn: true, authMethod: "claude.ai", email: "dummy@example.invalid", orgId: "org-scratch", subscriptionType: "max" };
const se = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null });
const TOOL_TURN = [
	{ type: "system", subtype: "init" },
	se({ type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50 }, output_tokens: 1 } } }),
	se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
	se({ type: "content_block_stop", index: 0 }),
	se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
	se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me " } }),
	se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "check." } }),
	se({ type: "content_block_stop", index: 1 }),
	se({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__np__ask_question", input: {} } }),
	se({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"question":' } }),
	se({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"Why?"}' } }),
	se({ type: "content_block_stop", index: 2 }),
	se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }),
	se({ type: "message_stop" }),
];
const setControl = (value: Record<string, unknown>) => writeFileSync(control, JSON.stringify({ auth: SUBSCRIPTION, lines: [], ...value }));

before(async () => {
	process.env.ANTHROPIC_API_KEY = "sk-ant-scratch-must-never-be-used";
	setControl({});
	bridge = await import("../src/agent/claude-code-bridge.ts");
	stream = await import("../src/agent/claude-code-stream.ts");
});
beforeEach(async () => { setControl({}); rmSync(record, { force: true }); bridge.setClaudeCodeBackgroundUse(true); await bridge.refreshClaudeCodeStatus(true); });
after(() => {
	if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = originalKey;
	rmSync(dir, { recursive: true, force: true });
});

const context = () => normalizeContext({
	systemPrompt: "Scratch teacher instructions",
	tools: [{ name: "ask_question", description: "Ask the learner", parameters: Type.Object({ question: Type.String() }) }],
	messages: [
		{ role: "user", content: [{ type: "text", text: "Teach me colours" }, { type: "image", data: "c2NyYXRjaA==", mimeType: "image/png" }], timestamp: 1 },
		{ role: "assistant", api: "anthropic-messages", provider: "claude-code", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Sure." }, { type: "toolCall", id: "toolu_0", name: "ask_question", arguments: { question: "Which colour?" } }], stopReason: "toolUse", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
		{ role: "toolResult", toolCallId: "toolu_0", toolName: "ask_question", content: [{ type: "text", text: "Learner said: blue" }], isError: false, timestamp: 3 },
	],
});
async function collect(background = false, signal?: AbortSignal) {
	const model = bridge.claudeCodeModel("claude-sonnet-5-5")!;
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream.claudeCodeStream(() => background)(model, context(), { reasoning: "high", signal })) events.push(event);
	return events;
}

test("status: only a claude.ai subscription sign-in counts; API-key logins never connect", async () => {
	assert.equal(bridge.claudeCodeConnected(), true);
	assert.equal(bridge.claudeCodeStatus().plan, "max");
	setControl({ auth: { loggedIn: true, authMethod: "api_key" } });
	await bridge.refreshClaudeCodeStatus(true);
	assert.equal(bridge.claudeCodeConnected(), false);
	assert.match(bridge.claudeCodeStatus().error ?? "", /API key/);
	assert.deepEqual(bridge.claudeCodeModels(), []);
});

test("catalog: current family only, zero cost, effort levels low…max", () => {
	const models = bridge.claudeCodeModels();
	assert.deepEqual(models.map((m) => m.id), ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
	for (const model of models) {
		assert.equal(model.provider, "claude-code");
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high", "xhigh", "max"]);
	}
});

test("request: system prompt + transport note, tool declarations, flattened transcript with inline image", () => {
	const request = stream.buildClaudeCodeRequest(context());
	assert.ok(request.systemPrompt.startsWith("Scratch teacher instructions"));
	assert.ok(request.systemPrompt.includes(stream.TRANSCRIPT_NOTE));
	assert.deepEqual(request.tools.map((t) => t.name), ["ask_question"]);
	const message = JSON.parse(request.input).message;
	assert.equal(message.role, "user");
	assert.deepEqual(message.content.map((b: { type: string }) => b.type), ["text", "image", "text"]);
	assert.deepEqual(message.content[1].source, { type: "base64", media_type: "image/png", data: "c2NyYXRjaA==" });
	const tail = message.content[2].text as string;
	assert.match(tail, /<tool_call id="toolu_0" name="ask_question">\n\{"question":"Which colour\?"\}\n<\/tool_call>/);
	assert.match(tail, /<tool_result id="toolu_0" name="ask_question">\nLearner said: blue\n<\/tool_result>/);
	assert.ok(tail.endsWith("</transcript>"));
});

test("args and env: no built-in tools or user settings, one turn, never an API key", () => {
	const args = stream.claudeCodeArgs({ modelId: "claude-opus-5-5", systemPrompt: "S", mcpConfig: "{}", effort: "xhigh", toolNames: ["ask_question"] });
	const after = (flag: string) => args[args.indexOf(flag) + 1];
	assert.equal(after("--tools"), "");
	assert.equal(after("--setting-sources"), "");
	assert.equal(after("--max-turns"), "1");
	assert.equal(after("--model"), "claude-opus-5-5");
	assert.equal(after("--effort"), "xhigh");
	assert.equal(after("--allowedTools"), "mcp__np__ask_question");
	for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--include-partial-messages"]) assert.ok(args.includes(flag), flag);
	const env = bridge.claudeCodeEnv({ ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "y", ANTHROPIC_BASE_URL: "z", PATH: "/bin" } as unknown as NodeJS.ProcessEnv);
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
	assert.equal(env.ANTHROPIC_BASE_URL, undefined);
	assert.equal(env.PATH, "/bin");
});

test("stream: text and a tool call come back to the Naipes loop with usage, zero cost", async () => {
	setControl({ lines: TOOL_TURN, keepAlive: true }); // must be killed at message_stop
	const events = await collect();
	const done = events.at(-1)!;
	assert.equal(done.type, "done");
	if (done.type !== "done") return;
	assert.equal(done.reason, "toolUse");
	assert.deepEqual(done.message.content, [
		{ type: "text", text: "Let me check." },
		{ type: "toolCall", id: "toolu_1", name: "ask_question", arguments: { question: "Why?" } },
	]);
	assert.equal(done.message.provider, "claude-code");
	assert.equal(done.message.usage.input, 3);
	assert.equal(done.message.usage.cacheRead, 100);
	assert.equal(done.message.usage.cacheWrite, 50);
	assert.equal(done.message.usage.output, 42);
	assert.equal(done.message.usage.cost.total, 0);
	assert.deepEqual(events.map((e) => e.type).filter((t) => t !== "text_delta" && t !== "toolcall_delta"), ["start", "text_start", "text_end", "toolcall_start", "toolcall_end", "done"]);
	const seen = JSON.parse(readFileSync(record, "utf8"));
	assert.equal(seen.apiKey, null, "ANTHROPIC_API_KEY must never reach Claude Code");
	assert.equal(seen.toolSearch, "false");
	assert.ok(seen.args.includes("--effort") && seen.args[seen.args.indexOf("--effort") + 1] === "high");
	const mcp = JSON.parse(seen.args[seen.args.indexOf("--mcp-config") + 1]);
	assert.ok(mcp.mcpServers.np, "tools are declared through the np MCP server");
});

test("background work is refused before spawning when background use is off", async () => {
	bridge.setClaudeCodeBackgroundUse(false);
	setControl({ lines: TOOL_TURN });
	const events = await collect(true);
	assert.equal(events.at(-1)!.type, "error");
	const last = events.at(-1)!;
	if (last.type === "error") assert.match(last.error.errorMessage ?? "", /background use is off/);
	assert.throws(() => readFileSync(record), "Claude Code was not spawned");
	// Foreground work still runs.
	const foreground = await collect(false);
	assert.equal(foreground.at(-1)!.type, "done");
});

test("errors from Claude Code become clear, fallback-free messages", async () => {
	setControl({ lines: [{ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1767225600" }] });
	const events = await collect();
	const last = events.at(-1)!;
	assert.equal(last.type, "error");
	if (last.type === "error") assert.match(last.error.errorMessage ?? "", /usage limit reached.*No API-key fallback/);
});

test("cancelling kills Claude Code and reports aborted", async () => {
	setControl({ hang: true });
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 300);
	const events = await collect(false, controller.signal);
	const last = events.at(-1)!;
	assert.equal(last.type, "error");
	if (last.type === "error") assert.equal(last.reason, "aborted");
});
