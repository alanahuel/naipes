/**
 * Claude Code as a MODEL (owner decision, 2026-11-01): each agent-loop
 * request spawns the user's own `claude -p` with no built-in tools, the
 * Naipes system prompt, and Naipes tools declared through a
 * declaration-only MCP server. Claude Code streams ONE assistant message;
 * any tool calls are handed back to the Naipes agent loop, which
 * executes them exactly as for every other provider. The process is killed
 * at message_stop, so the stub MCP server is never asked to run a tool.
 *
 * Claude Code cannot replay native tool_use/tool_result history over
 * stream-json input, so the transcript is flattened into one user message
 * (text with delimiters, images inline). Its deterministic rendering keeps
 * the growing prefix prompt-cacheable.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, AssistantMessage, AssistantMessageEvent, Message, Model, SimpleStreamOptions, StreamFunction, TextContent, ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getCurrentSystemPrompt, getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { PATHS } from "../../config.ts";
import { CLAUDE_CODE_PROVIDER } from "../core/contracts/claude-code.ts";
import { claudeCodeAbortController, claudeCodeBackgroundAllowed, claudeCodeDenial, claudeCodeEnv, claudeCodeScope, claudeCodeScopeCurrent, findClaudeBinary } from "./claude-code-bridge.ts";
import { markUnadmittedUsage, type AdmissionScope, type SubscriptionDispatchLifecycle } from "./subscription-request-cycle.ts";

export const MCP_SERVER_NAME = "np";
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const NO_FALLBACK = " No API-key fallback was used.";

export const TRANSCRIPT_NOTE = [
	"## Conversation transport",
	"The conversation so far arrives as a single message that replays the transcript in order: <user> blocks are the learner's messages, <assistant> blocks are your own earlier replies, <tool_call> blocks are tools you called (with their JSON arguments), and <tool_result> blocks are what those tools returned.",
	"Continue from the end of the transcript as the assistant. To use a tool, call it natively through the tool interface. Never write <tool_call>, <assistant> or other transcript tags in your reply.",
].join("\n");

export function claudeCodeError(message: string): string {
	if (/background/i.test(message)) return `Claude Code background use is off in this app. Enable it in Providers to run this work.${NO_FALLBACK}`;
	if (/not installed|ENOENT|executable/i.test(message)) return `Claude Code is not installed on this computer. Install it and sign in from Providers.${NO_FALLBACK}`;
	if (/usage limit|hit your limit|rate.?limit|429|quota|limit reached/i.test(message)) return `Claude subscription usage limit reached. Wait for it to reset and try again.${NO_FALLBACK}`;
	if (/log ?in|sign.?in|auth|401|403|oauth|token/i.test(message)) return `Claude Code is not signed in to a Claude subscription. Sign in from Providers and try again.${NO_FALLBACK}`;
	if (/cancel|abort|closed|disconnect|changed/i.test(message)) return `Claude Code request cancelled or connection changed.${NO_FALLBACK}`;
	if (/model|unavailable|not_found|404/i.test(message)) return `The selected Claude model is unavailable for this Claude Code account. Choose another model.${NO_FALLBACK}`;
	return `Claude Code request failed. Check that Claude Code works in a terminal, then retry.${NO_FALLBACK}`;
}

// ─── request building ────────────────────────────────────────────────────────
type WireBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

function contentBlocks(content: string | readonly (TextContent | { type: "image"; data: string; mimeType: string })[], out: WireBlock[], text: (s: string) => void) {
	if (typeof content === "string") { text(content); return; }
	for (const block of content) {
		if (block.type === "text") text(block.text);
		else if (block.type === "image") out.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
	}
}

/** Flatten a transcript into one Anthropic user message (text runs merged, images inline). */
export function transcriptToContent(messages: readonly Message[]): WireBlock[] {
	const out: WireBlock[] = [];
	const text = (s: string) => {
		const last = out.at(-1);
		if (last?.type === "text") last.text += s; else out.push({ type: "text", text: s });
	};
	text("<transcript>\n");
	for (const message of messages) {
		if (message.role === "system") continue; // replayed into the system prompt
		if (message.role === "user") { text("<user>\n"); contentBlocks(message.content, out, text); text("\n</user>\n"); }
		else if (message.role === "assistant") {
			text("<assistant>\n");
			for (const block of message.content) {
				if (block.type === "text" && block.text) text(`${block.text}\n`);
				else if (block.type === "toolCall") text(`<tool_call id="${block.id}" name="${block.name}">\n${JSON.stringify(block.arguments)}\n</tool_call>\n`);
			}
			text("</assistant>\n");
		} else if (message.role === "toolResult") {
			text(`<tool_result id="${message.toolCallId}" name="${message.toolName}"${message.isError ? ' error="true"' : ""}>\n`);
			contentBlocks(message.content, out, text);
			text("\n</tool_result>\n");
		}
	}
	text("</transcript>");
	return out;
}

export interface ClaudeCodeRequest {
	systemPrompt: string;
	tools: { name: string; description: string; inputSchema: unknown }[];
	input: string;
}
export function buildClaudeCodeRequest(context: TranscriptContext): ClaudeCodeRequest {
	const base = getCurrentSystemPrompt(context.messages);
	const tools = getCurrentTools(context.messages).map((tool) => {
		const declared = toToolDeclaration(tool);
		return { name: declared.name, description: declared.description, inputSchema: declared.parameters };
	});
	const input = JSON.stringify({ type: "user", message: { role: "user", content: transcriptToContent(context.messages) } }) + "\n";
	return { systemPrompt: base ? `${base}\n\n${TRANSCRIPT_NOTE}` : TRANSCRIPT_NOTE, tools, input };
}

export function claudeCodeArgs(options: { modelId: string; systemPrompt: string; mcpConfig: string; effort?: string; toolNames: string[] }): string[] {
	const args = [
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--tools", "", "--strict-mcp-config", "--mcp-config", options.mcpConfig,
		"--setting-sources", "", "--disable-slash-commands", "--no-session-persistence",
		"--system-prompt", options.systemPrompt, "--model", options.modelId, "--max-turns", "1",
	];
	if (options.toolNames.length) args.push("--allowedTools", options.toolNames.map((n) => MCP_PREFIX + n).join(","));
	if (options.effort) args.push("--effort", options.effort);
	return args;
}

/** Declaration-only MCP server: lists tools, refuses every call (it is never reached in practice). */
const STUB_SOURCE = `import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const tools = JSON.parse(readFileSync(process.argv[2], "utf8"));
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	let m; try { m = JSON.parse(line); } catch { return; }
	if (m.id === undefined) return;
	if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "naipes", version: "1" } } });
	else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools } });
	else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "Naipes executes this tool itself." }] } });
	else send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;
function stubScript(): string {
	const dir = path.join(PATHS.data, "claude-code");
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "mcp-declarations.mjs");
	writeFileSync(file, STUB_SOURCE);
	return file;
}

// ─── stream-json parsing ─────────────────────────────────────────────────────
function emptyMessage(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: CLAUDE_CODE_PROVIDER, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const STOP: Record<string, "stop" | "length" | "toolUse"> = { end_turn: "stop", stop_sequence: "stop", tool_use: "toolUse", max_tokens: "length", model_context_window_exceeded: "length", pause_turn: "stop", refusal: "stop" };

/** Turns Claude Code stream-json lines into pi assistant events for ONE message. */
export class ClaudeCodeParser {
	readonly message: AssistantMessage;
	/** Anthropic block index → our content index (null = dropped, e.g. thinking). */
	private blocks = new Map<number, { index: number; json?: string } | null>();
	private started = false;
	done = false;
	failure: string | null = null;
	constructor(model: Model<Api>, private readonly emit: (event: AssistantMessageEvent) => void) { this.message = emptyMessage(model); }

	private start() { if (!this.started) { this.started = true; this.emit({ type: "start", partial: this.message }); } }
	private usage(raw: Record<string, any> | undefined, final = false) {
		if (!raw) return;
		const u = this.message.usage;
		if (typeof raw.input_tokens === "number") u.input = raw.input_tokens;
		if (typeof raw.cache_read_input_tokens === "number") u.cacheRead = raw.cache_read_input_tokens;
		if (typeof raw.cache_creation_input_tokens === "number") u.cacheWrite = raw.cache_creation_input_tokens;
		if (typeof raw.cache_creation?.ephemeral_1h_input_tokens === "number") u.cacheWrite1h = raw.cache_creation.ephemeral_1h_input_tokens;
		if (typeof raw.output_tokens === "number" && (final || raw.output_tokens > u.output)) u.output = raw.output_tokens;
		u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
	}

	feed(line: string): void {
		if (this.done) return;
		let j: Record<string, any>;
		try { j = JSON.parse(line); } catch { return; }
		if (j.type === "result") {
			if (!this.done) this.failure = String(j.result || j.subtype || "Claude Code ended without a response");
			return;
		}
		if (j.type !== "stream_event" || j.parent_tool_use_id) return;
		const e = j.event as Record<string, any>;
		const content = this.message.content;
		switch (e.type) {
			case "message_start":
				this.message.responseId = e.message?.id;
				this.message.responseModel = e.message?.model;
				this.usage(e.message?.usage);
				this.start();
				break;
			case "content_block_start": {
				this.start();
				const block = e.content_block ?? {};
				if (block.type === "text") {
					content.push({ type: "text", text: "" });
					this.blocks.set(e.index, { index: content.length - 1 });
					this.emit({ type: "text_start", contentIndex: content.length - 1, partial: this.message });
				} else if (block.type === "tool_use") {
					const name = String(block.name ?? "");
					content.push({ type: "toolCall", id: String(block.id), name: name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name, arguments: {} });
					this.blocks.set(e.index, { index: content.length - 1, json: "" });
					this.emit({ type: "toolcall_start", contentIndex: content.length - 1, partial: this.message });
				} else this.blocks.set(e.index, null); // thinking arrives empty from Claude Code; not shown
				break;
			}
			case "content_block_delta": {
				const slot = this.blocks.get(e.index);
				if (!slot) break;
				if (e.delta?.type === "text_delta") {
					(content[slot.index] as TextContent).text += e.delta.text;
					this.emit({ type: "text_delta", contentIndex: slot.index, delta: e.delta.text, partial: this.message });
				} else if (e.delta?.type === "input_json_delta") {
					slot.json = (slot.json ?? "") + e.delta.partial_json;
					this.emit({ type: "toolcall_delta", contentIndex: slot.index, delta: e.delta.partial_json, partial: this.message });
				}
				break;
			}
			case "content_block_stop": {
				const slot = this.blocks.get(e.index);
				if (!slot) break;
				const block = content[slot.index]!;
				if (block.type === "text") this.emit({ type: "text_end", contentIndex: slot.index, content: block.text, partial: this.message });
				else if (block.type === "toolCall") {
					const raw = slot.json?.trim() || "{}";
					try {
						const parsed = JSON.parse(raw);
						if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
						(block as ToolCall).arguments = parsed;
					} catch { (block as ToolCall).argumentsError = `Tool arguments were not a valid JSON object: ${raw}`; }
					this.emit({ type: "toolcall_end", contentIndex: slot.index, toolCall: block as ToolCall, partial: this.message });
				}
				break;
			}
			case "message_delta":
				if (e.delta?.stop_reason) { this.message.rawStopReason = e.delta.stop_reason; this.message.stopReason = STOP[e.delta.stop_reason] ?? "stop"; }
				this.usage(e.usage, true);
				break;
			case "message_stop":
				if (this.message.content.some((c) => c.type === "toolCall")) this.message.stopReason = "toolUse";
				this.done = true;
				this.emit({ type: "done", reason: this.message.stopReason as "stop" | "length" | "toolUse", message: this.message });
				break;
		}
	}
}

// ─── the stream function ─────────────────────────────────────────────────────
export function claudeCodeStream(background: () => boolean, lifecycle?: SubscriptionDispatchLifecycle): StreamFunction<Api, SimpleStreamOptions> {
	return (logicalModel, context, options) => {
		const output = new AssistantMessageEventStream();
		const purpose = background();
		const { controller, release } = claudeCodeAbortController(purpose);
		const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		void (async () => {
			let scope: AdmissionScope | undefined;
			let committed = false;
			const parser = new ClaudeCodeParser(logicalModel, (event) => output.push(event));
			let toolsFile: string | undefined;
			try {
				if (logicalModel.provider !== CLAUDE_CODE_PROVIDER) throw new Error("model unavailable");
				scope = claudeCodeScope(logicalModel.id);
				lifecycle?.captured(scope);
				if (purpose && !claudeCodeBackgroundAllowed()) throw new Error("background use disabled");
				const binary = await findClaudeBinary();
				if (!binary) throw new Error("Claude Code is not installed");
				if (signal.aborted || !claudeCodeScopeCurrent(scope)) throw new Error("cancelled or connection changed");

				const request = buildClaudeCodeRequest(context);
				toolsFile = path.join(os.tmpdir(), `np-claude-tools-${randomUUID()}.json`);
				writeFileSync(toolsFile, JSON.stringify(request.tools));
				const mcpConfig = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: process.execPath, args: [stubScript(), toolsFile], env: { ELECTRON_RUN_AS_NODE: "1" } } } });
				const args = claudeCodeArgs({ modelId: logicalModel.id, systemPrompt: request.systemPrompt, mcpConfig, effort: options?.reasoning, toolNames: request.tools.map((t) => t.name) });
				const cwd = path.join(PATHS.data, "claude-code", "workdir");
				mkdirSync(cwd, { recursive: true });

				lifecycle?.beforeDispatch(scope);
				committed = true;
				const child = spawn(binary, args, { cwd, env: claudeCodeEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
				const kill = () => { if (child.exitCode === null && !child.killed) child.kill("SIGTERM"); };
				signal.addEventListener("abort", kill, { once: true });
				let stderr = "", buffer = "";
				child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
				child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
					buffer += chunk;
					let newline: number;
					while ((newline = buffer.indexOf("\n")) >= 0) {
						const line = buffer.slice(0, newline).trim();
						buffer = buffer.slice(newline + 1);
						if (line) parser.feed(line);
						if (parser.done) { kill(); return; } // one message only; never let the stub "run" a tool
					}
				});
				child.stdin.on("error", () => undefined);
				child.stdin.end(request.input);
				await new Promise<void>((resolve, reject) => {
					child.on("error", reject);
					child.on("close", () => { if (buffer.trim() && !parser.done) parser.feed(buffer.trim()); resolve(); });
				});
				signal.removeEventListener("abort", kill);
				if (signal.aborted) throw new Error("cancelled");
				if (!parser.done) throw new Error(parser.failure || stderr.trim() || "Claude Code ended without a response");
			} catch (error) {
				if (parser.done) return;
				if (!committed) {
					markUnadmittedUsage(parser.message.usage);
					lifecycle?.noDispatch(claudeCodeDenial(scope, controller, options?.signal?.aborted === true, purpose));
				}
				const message = parser.message;
				message.stopReason = signal.aborted ? "aborted" : "error";
				message.errorMessage = claudeCodeError(error instanceof Error ? error.message : String(error));
				output.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
			} finally {
				if (toolsFile) rmSync(toolsFile, { force: true });
				release();
				output.end();
			}
		})();
		return output;
	};
}
