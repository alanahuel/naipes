/** Spaced review persistence (src/store/review.ts): the repo's scratch
 *  data/review/ files, snapshotted and restored around the run. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import { REVIEW_FILES } from "../config.ts";
import { appendIntake, readIntake, readReviewSources, reviewFilesRevision, writeReviewSources } from "../src/store/review.ts";
import { emptyReviewSources } from "../src/core/review.ts";

const files = [REVIEW_FILES.sources, REVIEW_FILES.intake];
const saved = new Map<string, string>();
for (const f of files) {
	try {
		saved.set(f, fs.readFileSync(f, "utf-8"));
	} catch {
		/* absent */
	}
}
const clear = () => { for (const f of files) fs.rmSync(f, { force: true }); };
beforeEach(clear);
after(() => {
	clear();
	for (const [f, body] of saved) fs.writeFileSync(f, body, "utf-8");
});

describe("review store", () => {
	it("sources: absent → null; round-trips; corrupt → null; newer version refuses", () => {
		assert.equal(readReviewSources(), null);
		const s = { ...emptyReviewSources(Date.UTC(2026, 10, 4)), areas: ["area:x"] };
		writeReviewSources(s);
		assert.deepEqual(readReviewSources(), s);
		fs.writeFileSync(REVIEW_FILES.sources, "{torn", "utf-8");
		assert.equal(readReviewSources(), null);
		fs.writeFileSync(REVIEW_FILES.sources, JSON.stringify({ ...s, version: 9 }), "utf-8");
		assert.throws(() => readReviewSources());
	});

	it("intake: appends, skips torn lines, first release of an idea wins", () => {
		assert.deepEqual(readIntake(), []);
		appendIntake([{ nodeId: "a", day: "2026-11-04", reason: "backlog" }]);
		fs.appendFileSync(REVIEW_FILES.intake, "{torn\n", "utf-8");
		appendIntake([{ nodeId: "a", day: "2026-11-05", reason: "new" }, { nodeId: "b", day: "2026-11-05", reason: "new" }]);
		assert.deepEqual(readIntake(), [
			{ nodeId: "a", day: "2026-11-04", reason: "backlog" },
			{ nodeId: "b", day: "2026-11-05", reason: "new" },
		]);
		assert.ok(reviewFilesRevision() > 0);
	});
});
