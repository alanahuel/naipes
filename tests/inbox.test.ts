/**
 * Inbox folder suggestions (knowledge folder phase 3, owner 2026-11-05):
 * the pure graph rule (core/inbox.ts rankFolders).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { folderOf, rankFolders } from "../src/core/inbox.ts";

const node = (id: string, ...sources: string[]) => ({ id, provenance: sources.map((chatId) => ({ chatId })) });
const folders = new Map([
	["src_alg", "Matemáticas/Álgebra"],
	["src_alg2", "Matemáticas/Álgebra"],
	["src_his", "Historia"],
	["src_geo", "Geografía"],
]);
const any = () => true;

describe("inbox folder ranking", () => {
	it("knows a path's folder", () => {
		assert.equal(folderOf("Matemáticas/Álgebra/a.md"), "Matemáticas/Álgebra");
		assert.equal(folderOf("a.md"), "");
	});

	it("suggests the majority folder with at least two connecting ideas", () => {
		const graph = {
			nodes: [
				node("n1", "src_inbox", "src_alg"),
				node("n2", "src_inbox", "src_alg2"),
				node("n3", "src_inbox"),
				node("n4", "src_inbox", "src_his"),
				node("h1", "src_alg"),
			],
			chains: [{ premises: ["n3"], conclusion: "h1" }],
		};
		const r = rankFolders("src_inbox", graph, folders, any);
		assert.deepEqual(r.suggestion, { folder: "Matemáticas/Álgebra", count: 3 });
		assert.equal(r.total, 4);
		assert.deepEqual(r.alternatives, [{ folder: "Historia", count: 1 }]);
	});

	it("counts chain neighbours (b) as connections", () => {
		const graph = {
			nodes: [node("n1", "src_inbox"), node("n2", "src_inbox"), node("g1", "src_geo"), node("g2", "src_geo")],
			chains: [{ premises: ["n1", "g1"], conclusion: "g2" }, { premises: ["g2"], conclusion: "n2" }],
		};
		assert.deepEqual(rankFolders("src_inbox", graph, folders, any).suggestion, { folder: "Geografía", count: 2 });
	});

	it("needs two ideas, a majority and no tie", () => {
		const one = { nodes: [node("n1", "src_inbox", "src_his")], chains: [] };
		assert.equal(rankFolders("src_inbox", one, folders, any).suggestion, null, "one idea is not enough");
		const tie = { nodes: [node("n1", "src_inbox", "src_his"), node("n2", "src_inbox", "src_his"), node("n3", "src_inbox", "src_geo"), node("n4", "src_inbox", "src_geo")], chains: [] };
		const tied = rankFolders("src_inbox", tie, folders, any);
		assert.equal(tied.suggestion, null, "a tie suggests nothing");
		assert.deepEqual(tied.alternatives.map((a) => a.folder), ["Geografía", "Historia"]);
		const split = {
			nodes: [
				node("n1", "src_inbox", "src_his"), node("n2", "src_inbox", "src_his"),
				node("n3", "src_inbox", "src_geo"), node("n4", "src_inbox", "src_alg"),
			],
			chains: [],
		};
		assert.equal(rankFolders("src_inbox", split, folders, any).suggestion, null, "2 of 4 is not more than half");
	});

	it("ignores sessions, unknown sources and folders that are not destinations", () => {
		const graph = {
			nodes: [node("n1", "src_inbox", "chat_1", "src_his"), node("n2", "src_inbox", "src_unknown", "src_his"), node("n3", "src_inbox", "src_geo"), node("n4", "src_inbox", "src_geo")],
			chains: [],
		};
		const r = rankFolders("src_inbox", graph, folders, (folder) => folder !== "Geografía");
		assert.deepEqual(r.suggestion, { folder: "Historia", count: 2 });
		assert.equal(r.total, 2);
	});

	it("never counts the note itself or an idea twice for one folder", () => {
		const graph = { nodes: [node("n1", "src_inbox", "src_alg", "src_alg2"), node("n2", "src_inbox")], chains: [{ premises: ["n1"], conclusion: "n2" }] };
		const r = rankFolders("src_inbox", graph, folders, any);
		assert.equal(r.total, 2, "n1 once (two Álgebra notes) + n2 through the chain");
		assert.deepEqual(r.suggestion, { folder: "Matemáticas/Álgebra", count: 2 });
	});
});
