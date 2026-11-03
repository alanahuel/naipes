/** «Ahora» on Inicio (stage 5): the activity strip's "now" variant. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivitySection, type ActivityFeed } from "../components/activity-dock.tsx";

const extraction = (i: number) => ({ id: `s${i}`, chatId: `s${i}`, title: `Nota ${i}`, phase: "extracting", startedAt: i });
const feed = (n: number): ActivityFeed => ({ jobs: [], extractions: Array.from({ length: n }, (_, i) => extraction(i)) });

it("hidden while nothing runs", () => {
	assert.equal(renderToStaticMarkup(<ActivitySection variant="now" limit={3} feed={feed(0)} />), "");
});

it("three at most, then «See N more»", () => {
	const html = renderToStaticMarkup(<ActivitySection variant="now" limit={3} feed={feed(5)} />);
	assert.ok(html.includes('data-testid="now-section"'));
	assert.ok(html.includes(">Now<"));
	assert.equal((html.match(/data-testid="activity-blob-extraction"/g) ?? []).length, 3);
	assert.match(html, /data-testid="now-more"[^>]*>See 2 more</);
});

it("no «more» button when everything fits", () => {
	const html = renderToStaticMarkup(<ActivitySection variant="now" limit={3} feed={feed(2)} />);
	assert.ok(!html.includes("now-more"));
});
