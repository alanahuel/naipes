/**
 * PARSED-LEDGER CACHE (perf, owner 2026-11-10): the file-backed graph
 * store keeps each ledger's parsed records in memory, keyed by the file's
 * mtime + size and dropped on the store's own writes. These pin the
 * contract: reads stay truthful (own appends, rewrites, and writes from
 * outside the store all show), records are shared read-only (deep-frozen),
 * and every read hands out its own array.
 *
 * Isolated NP_DATA_DIR, set before any config-loading import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "np-ledger-cache-"));
process.env.NP_DATA_DIR = TMP_DATA;

const { graphStore } = await import("../src/store/graph.ts");
const { LEDGER_FILES } = await import("../config.ts");
type GraphNode = import("../src/core/contracts.ts").GraphNode;

test.after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const node = (id: string): GraphNode => ({
	id,
	name: id,
	statement: `${id} statement`,
	aliases: [],
	createdAt: "2026-11-10T00:00:00.000Z",
	provenance: [{ chatId: "chat_x", messageId: "m1" }],
});

test("own appends and rewrites show on the next read", () => {
	assert.deepEqual(graphStore.readNodes(), []);
	graphStore.appendNode(node("a"));
	assert.deepEqual(graphStore.readNodes().map((n) => n.id), ["a"]);
	graphStore.appendNode(node("b"));
	assert.deepEqual(graphStore.readNodes().map((n) => n.id), ["a", "b"]);
	graphStore.rewriteLedgers({ nodes: [node("c")] });
	assert.deepEqual(graphStore.readNodes().map((n) => n.id), ["c"]);
});

test("a write from outside the store (another process) is seen", () => {
	graphStore.rewriteLedgers({ nodes: [node("x")] });
	assert.deepEqual(graphStore.readNodes().map((n) => n.id), ["x"]);
	fs.appendFileSync(LEDGER_FILES.nodes, `${JSON.stringify(node("y"))}\n`);
	assert.deepEqual(graphStore.readNodes().map((n) => n.id), ["x", "y"], "size moved → re-parsed");
});

test("records are shared read-only; each read returns its own array", () => {
	graphStore.rewriteLedgers({ nodes: [node("p"), node("q")] });
	const first = graphStore.readNodes();
	assert.throws(() => {
		(first[0] as { name: string }).name = "mutated";
	}, TypeError, "a shared record cannot be mutated");
	assert.throws(() => {
		first[0]!.provenance.push({ chatId: "c", messageId: "m" });
	}, TypeError, "nor its nested arrays");
	first.reverse();
	first.push(node("r"));
	assert.deepEqual(graphStore.readNodes().map((n) => n.id), ["p", "q"], "sorting/pushing a read's array leaves the cache intact");
});
