/**
 * GRAPH DATA CACHES (perf, owner 2026-11-10).
 *
 * Client (components/graph-data.ts): one shared copy per view that
 * revalidates with If-None-Match — a 304 resolves to the SAME object,
 * concurrent loads share one request, and a load asked for mid-flight
 * runs once more so it never settles on pre-change data.
 *
 * Server (src/server/graph.ts + cached-json.ts): the canvas view is slim
 * (no propositions/chains, nodes without aliases/createdAt), carries the
 * counts, keeps one ETag while nothing changes and a new one after a write.
 *
 * Isolated NP_DATA_DIR, set before any config-loading import.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "np-graph-data-"));
process.env.NP_DATA_DIR = TMP_DATA;

const { graphStore } = await import("../src/store/graph.ts");
const { cachedJson, graphCanvasBody, graphChainsBody } = await import("../src/server/index.ts");
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("client graph cache (graph-data.ts)", () => {
	type Call = { url: string; ifNoneMatch: string | undefined; resolve: (r: Response) => void };
	const calls: Call[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((url: string, init?: { headers?: Record<string, string> }) =>
		new Promise<Response>((resolve) => calls.push({ url, ifNoneMatch: init?.headers?.["If-None-Match"], resolve }))) as typeof fetch;
	const ok = (body: unknown, etag: string) => new Response(JSON.stringify(body), { status: 200, headers: { ETag: etag } });
	const notModified = (etag: string) => new Response(null, { status: 304, headers: { ETag: etag } });
	const flush = () => new Promise((r) => setImmediate(r));

	it("loads, then revalidates: a 304 resolves to the same object", async () => {
		const { graphCanvas } = await import("../components/graph-data.ts");
		assert.equal(graphCanvas.peek(), null);
		const first = graphCanvas.load();
		await flush();
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.ifNoneMatch, undefined, "nothing cached yet → no validator");
		calls[0]!.resolve(ok({ nodes: [{ id: "a" }] }, '"v1"'));
		const a = await first;
		assert.equal(graphCanvas.peek(), a);

		const second = graphCanvas.load();
		await flush();
		assert.equal(calls[1]!.ifNoneMatch, '"v1"');
		calls[1]!.resolve(notModified('"v1"'));
		assert.equal(await second, a, "unchanged graph → the very same object");
	});

	it("concurrent loads share a request; one asked mid-flight gets a follow-up fetch", async () => {
		const { graphChains } = await import("../components/graph-data.ts");
		const before = calls.length;
		const p1 = graphChains.load();
		const p2 = graphChains.load(); // asked while p1 is in flight
		await flush();
		assert.equal(calls.length, before + 1, "one request in flight");
		calls[before]!.resolve(ok({ chains: [] }, '"w1"'));
		await flush();
		await flush();
		assert.equal(calls.length, before + 2, "the mid-flight ask triggered exactly one more fetch");
		calls[before + 1]!.resolve(ok({ chains: ["fresh"] }, '"w2"'));
		assert.deepEqual(await p1, { chains: [] });
		assert.deepEqual(await p2, { chains: ["fresh"] }, "the late asker settles on the post-change data");
		globalThis.fetch = realFetch;
	});
});

describe("server graph views (src/server/graph.ts)", () => {
	const node = (id: string) => ({
		id,
		name: id,
		statement: `${id} statement`,
		aliases: ["alias"],
		createdAt: "2026-11-10T00:00:00.000Z",
		provenance: [{ chatId: "src_x", messageId: "m1" }],
	});

	it("the canvas view is slim, counted, and keeps its ETag until something changes", () => {
		graphStore.appendNode(node("n1"));
		graphStore.appendNode(node("n2"));
		graphStore.appendChain({ id: "arg_1", premises: ["n1"], conclusion: "n2", provenance: [], createdAt: "2026-11-10T00:00:00.000Z" });
		const a = graphCanvasBody();
		const canvas = JSON.parse(a.body);
		assert.equal("propositions" in canvas, false);
		assert.equal("chains" in canvas, false);
		assert.deepEqual(Object.keys(canvas.nodes[0]).sort(), ["id", "name", "provenance", "statement"]);
		assert.deepEqual(canvas.counts, { propositions: 2, chains: 1 });
		const world = JSON.parse(graphChainsBody().body);
		assert.equal(world.propositions.length, 2);
		assert.deepEqual(world.propositions[0].aliases, ["alias"], "the chain table keeps the full records");
		assert.equal(world.chains.length, 1);

		assert.equal(graphCanvasBody().etag, a.etag, "nothing changed → same validator");
		graphStore.appendNode(node("n3"));
		assert.notEqual(graphCanvasBody().etag, a.etag, "a ledger write → new validator");
	});

	it("cachedJson answers 304 to a matching If-None-Match", async () => {
		const body = graphCanvasBody();
		const hit = cachedJson(new Request("http://x/api/graph", { headers: { "If-None-Match": body.etag } }), body);
		assert.equal(hit.status, 304);
		const miss = cachedJson(new Request("http://x/api/graph"), body);
		assert.equal(miss.status, 200);
		assert.equal(miss.headers.get("ETag"), body.etag);
		assert.equal(await miss.text(), body.body);
	});
});
