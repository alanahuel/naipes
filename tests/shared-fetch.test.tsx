import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

/**
 * SHARED FETCH (perf, owner 2026-11-10): components/shared-fetch.ts — one
 * copy per URL for every reader, a burst of server events → ONE fetch,
 * a mid-flight trigger → exactly one follow-up.
 */
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { useSharedFetch } from "../components/shared-fetch.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
});

const pending: { url: string; resolve: (body: unknown) => void }[] = [];
globalThis.fetch = ((url: string) =>
	new Promise<Response>((resolve) =>
		pending.push({ url, resolve: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })) }),
	)) as typeof fetch;

const handlers = new Map<string, (raw: string) => void>();
const source = {
	onEvent: (name: string, cb: (raw: string) => void) => void handlers.set(name, cb),
	onOpen: () => {},
	close: () => {},
};
const fire = (name: string) => handlers.get(name)?.("{}");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const seen: Record<string, unknown> = {};
function Reader({ name }: { name: string }) {
	const { data } = useSharedFetch<{ v: number }>("/api/exams", ["exams-changed", "turn-settled"]);
	seen[name] = data;
	return null;
}

it("two readers share one fetch; a burst of events coalesces into one refresh; mid-flight asks get one follow-up", async () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<ServerEventsProvider connect={() => source}>
				<Reader name="a" />
				<Reader name="b" />
			</ServerEventsProvider>,
		);
	});
	assert.equal(pending.length, 1, "first readers: one request between them");
	await act(async () => pending.shift()!.resolve({ v: 1 }));
	assert.deepEqual(seen.a, { v: 1 });
	assert.equal(seen.a, seen.b, "the very same object for both readers");

	// The (b) reader's mount scheduled one coalesced revalidation too.
	await act(async () => {
		for (let i = 0; i < 5; i++) fire(i % 2 ? "turn-settled" : "exams-changed");
		await wait(300);
	});
	assert.equal(pending.length, 1, "five events (and the second mount) → one fetch");
	// A trigger while that fetch is in flight → exactly one follow-up.
	await act(async () => {
		fire("exams-changed");
		await wait(300);
	});
	assert.equal(pending.length, 1, "still one in flight");
	await act(async () => pending.shift()!.resolve({ v: 2 }));
	assert.equal(pending.length, 1, "the mid-flight trigger ran once more");
	await act(async () => pending.shift()!.resolve({ v: 3 }));
	assert.deepEqual(seen.a, { v: 3 });
	assert.deepEqual(seen.b, { v: 3 });
	await act(async () => root.unmount());
	host.remove();
});
