import assert from "node:assert/strict";
import { it } from "node:test";
import { planProgress, type PlanTree } from "../src/core/contracts/plan.ts";

const tree: PlanTree = {
	nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" }],
	edges: [],
	version: 1,
};

it("«Paso X de Y»: distinct ideas reached (earlier stays + current) over the plan size", () => {
	assert.equal(planProgress(tree, { current: null, visited: new Set() }), null, "no step before the first tagged call");
	assert.deepEqual(planProgress(tree, { current: "a", visited: new Set() }), { step: 1, total: 4 });
	assert.deepEqual(planProgress(tree, { current: "c", visited: new Set(["a", "b"]) }), { step: 3, total: 4 });
	assert.deepEqual(planProgress(tree, { current: "a", visited: new Set(["a", "b"]) }), { step: 2, total: 4 }, "a revisit is not a new step");
});
