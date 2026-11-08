/**
 * smoke-mcp.mjs — prove the BUNDLED MCP server starts and answers over
 * stdio the way `naipes --mcp` runs it (owner, 2026-11-08): with --electron
 * through Electron's own Node (ELECTRON_RUN_AS_NODE), else host Node; a
 * THROWAWAY empty NP_DATA_DIR. Checks the handshake, the tool list, one
 * call, and that the data folder stays empty (the read-only law).
 *
 *   node scripts/smoke-mcp.mjs [--electron] [bundle]
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ELECTRON_MODE = process.argv.includes("--electron");
const RUNTIME = ELECTRON_MODE ? createRequire(import.meta.url)("electron") : process.execPath;
const BUNDLE = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? path.join(ROOT, ".next", "standalone", "mcp", "naipes-mcp.mjs"));

const fail = (message) => {
	console.error(`[smoke-mcp] FAILED: ${message}`);
	process.exit(1);
};
if (!fs.existsSync(BUNDLE)) fail(`bundle missing: ${BUNDLE} — run scripts/build-mcp.mjs first`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "np-smoke-mcp-"));
const child = spawn(RUNTIME, [BUNDLE], {
	cwd: os.tmpdir(),
	env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), NP_DATA_DIR: dataDir, ...(ELECTRON_MODE ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
	stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (b) => (stderr += b));
const timer = setTimeout(() => fail(`no answer in 20s. stderr:\n${stderr}`), 20_000);

const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let nl;
	while ((nl = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, nl);
		buffer = buffer.slice(nl + 1);
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			fail(`stdout carried a non-protocol line: ${line}`);
		}
		pending.get(message.id)?.(message);
	}
});
let nextId = 1;
const send = (method, params) => {
	const id = nextId++;
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	return new Promise((resolve) => pending.set(id, resolve));
};

try {
	const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
	if (init.result?.serverInfo?.name !== "naipes") fail(`bad initialize: ${JSON.stringify(init)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const list = await send("tools/list", {});
	const names = (list.result?.tools ?? []).map((t) => t.name);
	if (!names.includes("search_graph") || !names.includes("read_session")) fail(`tool list: ${names.join(", ")}`);
	const call = await send("tools/call", { name: "get_review_status", arguments: {} });
	if (call.result?.isError || !call.result?.content?.[0]?.text) fail(`get_review_status: ${JSON.stringify(call)}`);
	if (fs.readdirSync(dataDir).length > 0) fail(`the read-only server wrote into the data folder: ${fs.readdirSync(dataDir).join(", ")}`);
	console.log(`[smoke-mcp] OK — ${names.length} tools via ${ELECTRON_MODE ? "Electron (ELECTRON_RUN_AS_NODE)" : "Node"}`);
} finally {
	clearTimeout(timer);
	child.stdin.end();
	child.kill();
	fs.rmSync(dataDir, { recursive: true, force: true });
}
