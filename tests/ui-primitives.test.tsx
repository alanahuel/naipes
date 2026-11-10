/** The design-pass primitives (owner 2026-11-06): the shared Select, the
 *  two-line list row, the labelled progress bar, the narrow-window nav. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	self: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: clearTimeout,
});

const { Select } = await import("../components/ui/select.tsx");
const { ListRow } = await import("../components/ui/list.tsx");
const { ProgressBar } = await import("../components/ui/progress-bar.tsx");
const { PageHeader } = await import("../components/ui/page.tsx");
const { NarrowNav } = await import("../components/app-shell.tsx");

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
});
async function mount(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
}

describe("Select", () => {
	const options = [
		{ value: "a", label: "Alfa" },
		{ value: "b", label: "Beta" },
	];
	it("shows the current label on a listbox button and picks from the menu", async () => {
		const picked: string[] = [];
		await mount(<Select value="a" options={options} ariaLabel="Letra" onChange={(v) => picked.push(v)} testid="sel" />);
		const trigger = document.querySelector<HTMLButtonElement>('[data-testid="sel"]')!;
		assert.equal(trigger.getAttribute("aria-haspopup"), "listbox");
		assert.equal(trigger.textContent, "Alfa");
		assert.equal(document.querySelector('[role="listbox"]'), null, "closed by default");
		await act(async () => trigger.click());
		const opts = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
		assert.deepEqual(opts.map((o) => o.textContent), ["Alfa", "Beta"]);
		assert.equal(opts[0]!.getAttribute("aria-selected"), "true");
		await act(async () => opts[1]!.click());
		assert.deepEqual(picked, ["b"]);
		assert.equal(document.querySelector('[role="listbox"]'), null, "a pick closes the menu");
	});
	it("re-picking the current value is not a change; the placeholder shows for no match", async () => {
		const picked: string[] = [];
		await mount(<Select value="" placeholder="Elige…" options={options} ariaLabel="Letra" onChange={(v) => picked.push(v)} testid="sel" />);
		const trigger = document.querySelector<HTMLButtonElement>('[data-testid="sel"]')!;
		assert.equal(trigger.textContent, "Elige…");
		await act(async () => trigger.click());
		await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="a"]')!.click());
		assert.deepEqual(picked, ["a"]);
	});
	it("defaultOpen mounts open; Escape closes without picking and reports the dismissal", async () => {
		let dismissed = 0;
		await mount(<Select defaultOpen value="" options={options} ariaLabel="Letra" onChange={() => assert.fail("no pick")} onDismiss={() => dismissed++} />);
		const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
		assert.ok(listbox);
		const escape = Object.assign(new dom.window.Event("keydown", { bubbles: true }), { key: "Escape" });
		await act(async () => listbox.dispatchEvent(escape));
		assert.equal(document.querySelector('[role="listbox"]'), null);
		assert.equal(dismissed, 1);
	});
});

describe("ListRow (two lines)", () => {
	it("title truncates with its full text in the tooltip; meta on its own line; the action never wraps", () => {
		const html = renderToStaticMarkup(
			<ul>
				<ListRow title="Química UNED +25 — Parcial febrero" meta="~18 min hoy · faltan 89 días" action={<button type="button">Empezar →</button>} href="/exams/x" />
			</ul>,
		);
		assert.match(html, /class="block truncate[^"]*" title="Química UNED \+25 — Parcial febrero"/);
		assert.match(html, /<div class="truncate text-xs text-muted-foreground">~18 min hoy · faltan 89 días<\/div>/);
		assert.match(html, /<div class="flex shrink-0 items-center gap-2"><button/);
	});
});

describe("ProgressBar", () => {
	it("labels the target tick in detail views, stays decorative without a label", () => {
		const labelled = renderToStaticMarkup(<ProgressBar value={0} target={70} label="0% del temario; objetivo 70%" showTargetLabel />);
		assert.match(labelled, /role="img" aria-label="0% del temario; objetivo 70%"/);
		assert.match(labelled, />70%<\/span>/);
		const bare = renderToStaticMarkup(<ProgressBar value={40} target={90} />);
		assert.match(bare, /aria-hidden="true"/);
		assert.ok(!/>90%</.test(bare));
	});
});

describe("PageHeader", () => {
	it("clamps long titles to two lines with the full text in the tooltip", () => {
		const html = renderToStaticMarkup(<PageHeader title="Un título muy largo" actions={<span>acc</span>} />);
		assert.match(html, /<h1 class="line-clamp-2[^"]*" title="Un título muy largo">/);
	});
});

describe("NarrowNav", () => {
	it("names the current section and lists all six tabs on demand", async () => {
		await mount(<NarrowNav pathname="/exams/abc" />);
		const button = document.querySelector<HTMLButtonElement>('[data-testid="narrow-nav-button"]')!;
		assert.match(button.textContent ?? "", /Exams/);
		await act(async () => button.click());
		const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="narrow-nav-menu"] a')];
		assert.equal(links.length, 6);
		assert.equal(links.filter((a) => a.getAttribute("aria-current") === "page").length, 1);
	});
});
