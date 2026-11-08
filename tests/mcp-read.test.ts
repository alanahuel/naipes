/** The MCP server's read tools end to end (owner, 2026-11-08): a real MCP
 *  client over the in-memory transport, an isolated temporary data dir
 *  (NP_DATA_DIR set before any import), synthetic records only. The
 *  read-only law is checked byte for byte: no tool may create, change or
 *  remove anything in the data folder. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "np-mcp-"));
process.env.NP_DATA_DIR = DIR;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createNaipesMcpServer, MCP_INSTRUCTIONS, SESSION_PAGE_CHARS } = await import("../src/mcp/server.ts");

const t0 = Date.now() - 20 * 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function seed(dir: string) {
	fs.mkdirSync(path.join(dir, "chats"), { recursive: true });
	fs.mkdirSync(path.join(dir, "graph"), { recursive: true });
	fs.mkdirSync(path.join(dir, "exams"), { recursive: true });
	const quiz = { kind: "quiz", questionType: "check", correct: true, confidence: 90, dontKnow: false, answers: [], questionText: "q", answeredAt: iso(t0 + 2) };
	const chat = (id: string, title: string, text: string, kind?: "practice") => ({
		id, title, createdAt: iso(t0), updatedAt: iso(t0 + 3), ...(kind ? { kind } : {}),
		messages: [
			{ id: `${id}_u`, role: "user", content: [{ type: "text", text: "Quiero entender la dicotomía del control" }], timestamp: t0 },
			{ id: `${id}_m1`, role: "assistant", content: [{ type: "text", text }], timestamp: t0 + 1 },
			{ id: `${id}_q1`, role: "assistant", content: [{ type: "toolCall", id: `${id}_k1`, name: "quiz", arguments: { nodeId: "n_a1", type: "check" } }], timestamp: t0 + 1 },
			{ id: `${id}_a1`, role: "toolResult", toolCallId: `${id}_k1`, toolName: "quiz", content: [], isError: false, timestamp: t0 + 2, details: quiz },
		],
	});
	const chats = [chat("chat_a", "Estoicismo", "Epicteto distingue lo que depende de nosotros. " + "x".repeat(SESSION_PAGE_CHARS)), chat("chat_b", "Física", "La energía se conserva.", "practice")];
	for (const c of chats) fs.writeFileSync(path.join(dir, "chats", `${c.id}.json`), JSON.stringify(c));
	const node = (id: string, name: string, statement: string, chatId: string) => ({ id, name, statement, aliases: [], createdAt: iso(t0), provenance: [{ chatId, messageId: `${chatId}_m1` }] });
	const nodes = [
		node("n_a1", "Dicotomía del control", "Algunas cosas dependen de nosotros y otras no.", "chat_a"),
		node("n_a2", "Serenidad", "Ocuparse solo de lo que depende de uno trae serenidad.", "chat_a"),
		node("n_b1", "Conservación de la energía", "La energía total de un sistema aislado es constante.", "chat_b"),
	];
	fs.writeFileSync(path.join(dir, "graph", "nodes.jsonl"), nodes.map((n) => JSON.stringify(n)).join("\n") + "\n");
	const chain = { id: "arg_1", premises: ["n_a1"], conclusion: "n_a2", provenance: [{ chatId: "chat_a", messageId: "chat_a_m1" }], createdAt: iso(t0) };
	fs.writeFileSync(path.join(dir, "graph", "chains.jsonl"), JSON.stringify(chain) + "\n");
	const examDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
	const exam = {
		version: 2, id: "exam_test_1", title: "Filosofía", examDate, createdAt: iso(t0), updatedAt: iso(t0), status: "active",
		standard: { preset: "pass", recall: 0.8, mode: "recall", coverage: 0.7 },
		syllabus: { text: "Tema 1: estoicismo", fileName: null, folders: [], directFolders: [] },
		context: { kind: "personal", name: "", institution: "", location: "", sitting: "", goal: "" },
		materials: [{ id: "mat_1", kind: "link", name: "Apuntes", url: "https://example.com", addedAt: iso(t0) }],
		blocks: [{ id: "b1", title: "Estoicismo", points: [{ id: "p1", text: "La dicotomía del control", nodeIds: ["n_a1"] }] }],
		mapping: { state: "done" }, priorityBlocks: [],
	};
	fs.writeFileSync(path.join(dir, "exams", "exam_test_1.json"), JSON.stringify(exam));
}

/** path → content, for the whole tree (the read-only law's witness). */
function snapshot(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (rel: string) => {
		for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
			const child = path.join(rel, e.name);
			if (e.isDirectory()) {
				out.set(`${child}/`, "");
				walk(child);
			} else out.set(child, fs.readFileSync(path.join(dir, child), "utf-8"));
		}
	};
	walk("");
	return out;
}

async function connect() {
	const server = createNaipesMcpServer("test");
	const client = new Client({ name: "test", version: "0" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	return client;
}

type Client = Awaited<ReturnType<typeof connect>>;

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await client.callTool({ name, arguments: args });
	const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
	return { text, isError: Boolean(result.isError), json: () => JSON.parse(text) };
}

const ALL_READS: Array<[string, Record<string, unknown>]> = [
	["list_sessions", {}],
	["read_session", { id: "chat_a" }],
	["search_graph", { query: "control" }],
	["get_proposition", { id: "n_a1" }],
	["list_graph_sources", {}],
	["list_propositions", {}],
	["get_review_status", { include_all: true }],
	["list_exams", {}],
	["get_exam", { id: "exam_test_1" }],
];

describe("MCP read tools", () => {
	let client: Client;
	before(async () => {
		seed(DIR);
		client = await connect();
	});

	it("advertises the read tools, all read-only, with the evidence caveats", async () => {
		const { tools } = await client.listTools();
		assert.deepEqual(tools.map((t) => t.name).sort(), ALL_READS.map(([n]) => n).sort());
		for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
		assert.equal(client.getInstructions(), MCP_INSTRUCTIONS);
		assert.match(MCP_INSTRUCTIONS, /NOT a mastery assessment/);
	});

	it("list_sessions: kinds, title filter", async () => {
		const all = (await call(client, "list_sessions")).json();
		assert.equal(all.total, 2);
		assert.deepEqual((await call(client, "list_sessions", { kind: "practice" })).json().sessions.map((s: { id: string }) => s.id), ["chat_b"]);
		assert.deepEqual((await call(client, "list_sessions", { query: "estoic" })).json().sessions.map((s: { id: string }) => s.id), ["chat_a"]);
	});

	it("read_session: Markdown in pages; unknown and malformed ids fail", async () => {
		const first = await call(client, "read_session", { id: "chat_a" });
		assert.match(first.text, /# Estoicismo/);
		assert.match(first.text, /Epicteto/);
		const next = Number(/nextOffset (\d+)/.exec(first.text)?.[1]);
		assert.equal(next, SESSION_PAGE_CHARS);
		const second = await call(client, "read_session", { id: "chat_a", offset: next });
		assert.doesNotMatch(second.text, /nextOffset/);
		assert.equal((await call(client, "read_session", { id: "chat_zz" })).isError, true);
		assert.equal((await call(client, "read_session", { id: "../settings" })).isError, true);
	});

	it("graph: search, proposition with chains and provenance, sources", async () => {
		assert.deepEqual((await call(client, "search_graph", { query: "energía" })).json().propositions.map((p: { id: string }) => p.id), ["n_b1"]);
		const p = (await call(client, "get_proposition", { id: "n_a1" })).json();
		assert.equal(p.name, "Dicotomía del control");
		assert.deepEqual(p.chains, [{ id: "arg_1", premises: [{ id: "n_a1", name: "Dicotomía del control" }], conclusion: { id: "n_a2", name: "Serenidad" } }]);
		assert.equal(p.provenance[0].sourceName, "Estoicismo");
		assert.equal((await call(client, "get_proposition", { id: "n_nope" })).isError, true);
		const sources = (await call(client, "list_graph_sources")).json().sources;
		assert.deepEqual(sources.map((s: { id: string; propositions: number }) => [s.id, s.propositions]).sort(), [["chat_a", 2], ["chat_b", 1]]);
		assert.equal((await call(client, "list_propositions", { source: "chat_b" })).json().total, 1);
	});

	it("review status is computed from the records", async () => {
		const r = (await call(client, "get_review_status", { include_all: true })).json();
		assert.equal(typeof r.today, "string");
		assert.ok(Array.isArray(r.due));
		assert.ok(r.enrolled.some((i: { id: string }) => i.id === "n_a1"));
	});

	it("exams: list and stored detail", async () => {
		const list = (await call(client, "list_exams")).json().exams;
		assert.deepEqual(list.map((e: { id: string; points: number; pointsLinkedToGraph: number }) => [e.id, e.points, e.pointsLinkedToGraph]), [["exam_test_1", 1, 1]]);
		const e = (await call(client, "get_exam", { id: "exam_test_1" })).json();
		assert.equal(e.blocks[0].points[0].propositions[0], "n_a1");
		assert.equal(e.materials[0].url, "https://example.com");
		assert.equal((await call(client, "get_exam", { id: "exam_nope" })).isError, true);
	});

	it("READ-ONLY LAW: no tool changes the data folder", async () => {
		const before = snapshot(DIR);
		for (const [name, args] of ALL_READS) await call(client, name, args);
		assert.deepEqual(snapshot(DIR), before);
	});

	it("READ-ONLY LAW: an empty data folder stays empty", async () => {
		// The stores resolve NP_DATA_DIR at import, so the same folder is
		// emptied in place: a fresh install (no chats/, graph/, exams/…).
		for (const entry of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, entry), { recursive: true, force: true });
		for (const [name, args] of ALL_READS) await call(client, name, args);
		assert.deepEqual([...snapshot(DIR).keys()], []);
	});
});
