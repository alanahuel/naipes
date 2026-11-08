/** The MCP write path end to end (owner, 2026-11-08): the REAL local API
 *  listener (src/server/mcp-api.ts) on a free loopback port, a real MCP
 *  client over the in-memory transport, isolated temporary data, keys and
 *  knowledge folders (env set before any import). Synthetic records only,
 *  no model calls (no model is configured: agent starts refuse with 503). */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "np-mcp-write-"));
const DIR = path.join(ROOT, "data");
const VAULT = path.join(ROOT, "vault");
fs.mkdirSync(path.join(DIR, "graph"), { recursive: true });
fs.mkdirSync(VAULT);
process.env.NP_DATA_DIR = DIR;
process.env.NP_AUTH_FILE = path.join(ROOT, "auth.json");
delete process.env.NAIPES_MCP_TOKEN;
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const freePort = () =>
	new Promise<number>((resolve) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as net.AddressInfo;
			srv.close(() => resolve(port));
		});
	});
const PORT = await freePort();

const { writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { reconfigureMcpApi, mcpApiStatus } = await import("../src/server/mcp-api.ts");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createNaipesMcpServer } = await import("../src/mcp/server.ts");
const { listMcpDeletions, decideMcpDeletion, setMcpDeletionTimeoutForTests } = await import("../src/server/mcp-deletions.ts");
const { readExam } = await import("../src/store/exams.ts");

const iso = new Date().toISOString();
fs.writeFileSync(
	path.join(DIR, "graph", "nodes.jsonl"),
	[{ id: "n_1", name: "Dicotomía del control", statement: "Algunas cosas dependen de nosotros.", aliases: [], createdAt: iso, provenance: [{ chatId: "chat_x", messageId: "" }] }]
		.map((n) => JSON.stringify(n))
		.join("\n") + "\n",
);

const settings = (mcp: { enabled: boolean; port: number }) =>
	writeSettings({
		version: 1,
		mcp,
		obsidian: { enabled: true, vaultPath: VAULT, folders: [], outputFolder: "007 - NAIPES", obsidianFormat: false, confirmAboveRuns: 6, suggestFolders: true, inboxFolder: "Bandeja" },
	});

async function connect() {
	const server = createNaipesMcpServer("test");
	const client = new Client({ name: "test", version: "0" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	return client;
}
type McpClient = Awaited<ReturnType<typeof connect>>;
async function call(client: McpClient, name: string, args: Record<string, unknown> = {}) {
	const result = await client.callTool({ name, arguments: args });
	const text = (result.content as Array<{ text: string }>)[0]!.text;
	return { text, isError: Boolean(result.isError), json: () => JSON.parse(text) };
}

describe("MCP write path (real listener)", () => {
	let client: McpClient;
	let token: string;
	before(async () => {
		settings({ enabled: true, port: PORT });
		await reconfigureMcpApi();
		const status = await mcpApiStatus();
		assert.equal(status.listening, true);
		assert.equal(status.port, PORT);
		token = status.token!;
		assert.ok(token.length >= 32);
		process.env.NAIPES_MCP_TOKEN = token;
		client = await connect();
	});
	after(async () => {
		settings({ enabled: false, port: PORT });
		await reconfigureMcpApi();
	});

	it("the listener refuses without the token, from a browser, and serves with it", async () => {
		const url = `http://127.0.0.1:${PORT}/v1/status`;
		assert.equal((await fetch(url)).status, 401);
		assert.equal((await fetch(url, { headers: { authorization: "Bearer nope" } })).status, 401);
		assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" } })).status, 403);
		assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 200);
	});

	it("create_session: created, NOT opened — the goal waits as the pending opening; picks seed the context", async () => {
		const r = await call(client, "create_session", { goal: "Quiero entender la dicotomía del control", proposition_ids: ["n_1"] });
		assert.equal(r.isError, false, r.text);
		const { created, opened } = r.json();
		assert.equal(opened, false);
		const record = chatStore.getChat(created.id)!;
		assert.equal(record.pendingOpening, "Quiero entender la dicotomía del control");
		assert.equal(record.messages.length, 1, "only the graph-context marker");
		assert.equal(record.messages.some((m) => m.role === "user"), false);
		const bad = await call(client, "create_session", { goal: "x", proposition_ids: ["n_nope"] });
		assert.equal(bad.isError, true);
		assert.match(bad.text, /unknown proposition ids: n_nope/);
	});

	it("the store clears the pending opening (the first turn spends it)", () => {
		const chat = chatStore.createChat("t");
		chatStore.setPendingOpening(chat.id, "hola");
		assert.equal(chatStore.getChat(chat.id)!.pendingOpening, "hola");
		chatStore.setPendingOpening(chat.id, null);
		assert.equal("pendingOpening" in chatStore.getChat(chat.id)!, false);
	});

	it("start_review_session: nothing due is an honest refusal", async () => {
		const r = await call(client, "start_review_session");
		assert.equal(r.isError, true);
		assert.match(r.text, /nothing due/);
	});

	it("add_inbox_note: exactly «<title>.md» with the text; clashes get (2); list_inbox sees them", async () => {
		const r = await call(client, "add_inbox_note", { title: "Ideas: estoicismo/Epicteto", content: "# Hola\n\nTexto." });
		assert.equal(r.isError, false, r.text);
		const saved = r.json().saved as string;
		assert.equal(saved, "Bandeja/Ideas estoicismo Epicteto.md");
		assert.equal(fs.readFileSync(path.join(VAULT, saved), "utf-8"), "# Hola\n\nTexto.");
		assert.equal((await call(client, "add_inbox_note", { title: "Ideas: estoicismo/Epicteto", content: "otra" })).json().saved, "Bandeja/Ideas estoicismo Epicteto (2).md");
		const inbox = (await call(client, "list_inbox")).json();
		assert.equal(inbox.inbox, "Bandeja");
		assert.deepEqual(inbox.items.map((i: { path: string }) => i.path).sort(), ["Bandeja/Ideas estoicismo Epicteto (2).md", "Bandeja/Ideas estoicismo Epicteto.md"]);
	});

	it("exams: create (draft) → update → materials (url, text, file) → plan; refusals stay honest", async () => {
		const created = await call(client, "create_exam", { title: "Filosofía", exam_date: "2027-01-20", syllabus_text: "Tema 1: estoicismo", context: { kind: "personal", goal: "aprobar" } });
		assert.equal(created.isError, false, created.text);
		const { id, status } = created.json().created;
		assert.equal(status, "draft");
		assert.equal((await call(client, "update_exam", { id, title: "Filosofía I", standard: "merit" })).isError, false);
		assert.equal((await call(client, "add_exam_material", { id, url: "https://example.com/guia" })).isError, false);
		assert.equal((await call(client, "add_exam_material", { id, text: "Apuntes pegados", name: "Apuntes" })).isError, false);
		const file = path.join(ROOT, "temario.md");
		fs.writeFileSync(file, "# Temario");
		assert.equal((await call(client, "add_exam_material", { id, path: file })).isError, false);
		assert.match((await call(client, "add_exam_material", { id, path: path.join(ROOT, "x.exe") })).text, /Unsupported format/);
		assert.match((await call(client, "add_exam_material", { id })).text, /exactly one/);

		const exam = (await call(client, "get_exam", { id })).json();
		assert.equal(exam.title, "Filosofía I");
		assert.equal(exam.standard.preset, "merit");
		assert.equal(exam.materials.length, 3);
		assert.ok(exam.plan, JSON.stringify(exam.planUnavailable));
		assert.equal(typeof exam.plan.daysLeft, "number");

		const session = await call(client, "start_exam_session", { id, kind: "placement" });
		assert.equal(session.isError, true);
		assert.match(session.text, /not active/);
		const mapped = await call(client, "run_exam_agent", { id, agent: "map" });
		assert.equal(mapped.isError, true);
		assert.match(mapped.text, /Settings → AI/);
		assert.match((await call(client, "run_exam_agent", { id, agent: "guide" })).text, /guide_action/);
	});

	it("deletions wait for the learner: rejected keeps, deleted removes, silence times out", async () => {
		const pendingOne = async () => {
			for (let i = 0; i < 200; i++) {
				const list = listMcpDeletions();
				if (list.length > 0) return list[0]!;
				await new Promise((r) => setTimeout(r, 10));
			}
			throw new Error("no pending deletion");
		};
		const examId = (await call(client, "create_exam", { title: "Para borrar", exam_date: "2027-03-01", syllabus_text: "x" })).json().created.id;

		// Rejected: nothing deleted.
		const rejected = call(client, "delete_exam", { id: examId });
		const req = await pendingOne();
		assert.deepEqual([req.kind, req.targetId, req.label, req.client], ["exam", examId, "Para borrar", "test"]);
		assert.deepEqual(await decideMcpDeletion(req.id, "reject"), { ok: true });
		assert.equal((await rejected).json().outcome, "rejected");
		assert.ok(readExam(examId));

		// Deleted: the session's traces box starts at the model's suggestion,
		// the learner's answer wins.
		const chat = (await call(client, "create_session", { goal: "Borrable" })).json().created;
		const deleted = call(client, "delete_session", { id: chat.id, remove_graph_traces: true });
		const sreq = await pendingOne();
		assert.equal(sreq.suggestTraces, true);
		assert.deepEqual(await decideMcpDeletion(sreq.id, "delete", false), { ok: true });
		assert.deepEqual((await deleted).json().outcome, "deleted");
		assert.equal((await deleted).json().removedGraphTraces, false);
		assert.equal(chatStore.getChat(chat.id), null);
		assert.equal((await decideMcpDeletion(sreq.id, "delete")).ok, false, "a settled request cannot be decided again");

		// Unknown targets never reach the learner.
		assert.match((await call(client, "delete_proposition", { id: "n_nope" })).text, /no proposition with id n_nope/);
		assert.equal(listMcpDeletions().length, 0);

		// Silence: the request expires and nothing is deleted.
		setMcpDeletionTimeoutForTests(50);
		const r = await call(client, "delete_proposition", { id: "n_1" });
		assert.equal(r.json().outcome, "timeout");
		assert.equal(listMcpDeletions().length, 0);
		assert.ok(fs.readFileSync(path.join(DIR, "graph", "nodes.jsonl"), "utf-8").includes('"n_1"'));
	});

	it("without the token or with the app unreachable, writes explain what to do", async () => {
		delete process.env.NAIPES_MCP_TOKEN;
		assert.match((await call(client, "add_inbox_note", { title: "t", content: "c" })).text, /Conexión MCP/);
		process.env.NAIPES_MCP_TOKEN = "wrong-token-wrong-token-wrong-token-12";
		assert.match((await call(client, "add_inbox_note", { title: "t", content: "c" })).text, /rejected this MCP server's token/);
		process.env.NAIPES_MCP_TOKEN = token;
		settings({ enabled: false, port: PORT });
		await reconfigureMcpApi();
		assert.equal((await mcpApiStatus()).listening, false);
		const r = await call(client, "add_inbox_note", { title: "t", content: "c" });
		assert.equal(r.isError, true);
		assert.match(r.text, /not reachable/);
		// Reads still work, and the plan says why it is missing.
		const exams = (await call(client, "list_exams")).json().exams;
		const exam = (await call(client, "get_exam", { id: exams[0].id })).json();
		assert.equal(exam.plan, null);
		assert.match(exam.planUnavailable, /not reachable/);
		settings({ enabled: true, port: PORT });
		await reconfigureMcpApi();
	});
});
