import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { PracticeDock } from "../components/practice-dock.tsx";
import { ConfidenceSlider } from "../components/confidence-rail.tsx";
import { renderToStaticMarkup } from "react-dom/server";

/* Owner 2026-11-09: the confidence is NEVER pre-filled. A send without
 * one is refused and flags «Elige tu seguridad»; any change to the answer
 * and every submission empty it again. */

async function mount(node: React.ReactElement) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	// React only wires its input events when the document says it has them.
	Object.assign(dom.document, { oninput: null });
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(node); });
	return () => {
		act(() => { root.unmount(); });
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
}

/** Set a form control's value the way React's change tracking notices. */
function input(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
	const proto = Object.getPrototypeOf(el) as object;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	if (setter) setter.call(el, value);
	else (el as { value: string }).value = value;
	el.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
}

it("the slider renders unchosen: no value, hidden disc", () => {
	const html = renderToStaticMarkup(<ConfidenceSlider value={null} onChange={() => {}} label="Seguridad" missingLabel="Elige tu seguridad" ariaLabel="a" valueText="—" />);
	assert.ok(html.includes('data-chosen="false"'));
	assert.ok(html.includes("—"));
	assert.ok(html.includes(">—</span>"), "no stated value");
	const missing = renderToStaticMarkup(<ConfidenceSlider value={null} missing onChange={() => {}} label="Seguridad" missingLabel="Elige tu seguridad" ariaLabel="a" valueText="—" />);
	assert.ok(missing.includes("Elige tu seguridad"));
});

it("the practice dock refuses a send without confidence, then empties it after each send and on every edit", async () => {
	const sent: { text: string; confidence: number }[] = [];
	const cleanup = await mount(
		<PracticeDock problemCallId="p1" input={{ statement: "S" }} expanded onExpand={() => {}} onSubmit={(text, confidence) => { sent.push({ text, confidence }); }} />,
	);
	try {
		const slot = () => document.querySelector<HTMLElement>('[data-testid="practice-confidence"]')!;
		const range = () => slot().querySelector<HTMLInputElement>('input[type="range"]')!;
		const area = () => document.querySelector<HTMLTextAreaElement>('[data-testid="practice-thinking-field"] textarea')!;
		const send = () => document.querySelector<HTMLButtonElement>('[data-testid="practice-send"]')!;
		assert.equal(slot().getAttribute("data-chosen"), "false", "never pre-filled");

		act(() => { input(area(), "x = 2"); });
		act(() => { send().click(); });
		assert.equal(sent.length, 0, "no send without a stated confidence");
		assert.equal(slot().getAttribute("data-missing"), "true");

		act(() => { input(range(), "90"); });
		assert.equal(slot().getAttribute("data-chosen"), "true");
		assert.equal(slot().getAttribute("data-missing"), "false");

		act(() => { input(area(), "x = 3"); });
		assert.equal(slot().getAttribute("data-chosen"), "false", "editing the answer empties it");

		act(() => { input(range(), "70"); });
		act(() => { send().click(); });
		assert.deepEqual(sent, [{ text: "x = 3", confidence: 70 }]);
		assert.equal(slot().getAttribute("data-chosen"), "false", "each attempt states its own");
	} finally {
		cleanup();
	}
});

it("the quiz dock: unchosen at start, refuses the send, and changing the option or the thinking empties it", async () => {
	const { QuestionDock } = await import("../components/question-dock.tsx");
	const sent: unknown[] = [];
	const cleanup = await mount(
		<QuestionDock toolName="probe" toolCallId="q1" input={{ question: "Q?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "A." }} expanded dictationClaim={false} onExpand={() => {}} onSubmit={(a) => { sent.push(a); }} />,
	);
	try {
		const track = () => document.querySelector<HTMLElement>('[data-testid="confidence-track"]')!;
		const range = () => document.querySelector<HTMLInputElement>('[data-testid="confidence-slider"]')!;
		const rows = () => [...document.querySelectorAll<HTMLButtonElement>("[data-kbdrow]")];
		const thinking = () => document.querySelector<HTMLTextAreaElement>('[data-testid="thinking-field"] textarea')!;
		// linkedom doesn't turn a submit-button click into a form submit.
		const form = () => document.querySelector<HTMLFormElement>('[data-testid="question-dock"] form')!;
		const send = () => ({ click: () => form().dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })) });
		assert.equal(track().getAttribute("data-chosen"), "false", "never pre-filled");
		assert.equal(document.querySelector('[data-testid="confidence-value"]')?.textContent, "—");

		act(() => { rows()[0]!.click(); });
		act(() => { input(range(), "90"); });
		assert.equal(track().getAttribute("data-chosen"), "true");
		act(() => { rows()[1]!.click(); });
		assert.equal(track().getAttribute("data-chosen"), "false", "another option empties it");

		act(() => { input(range(), "70"); });
		act(() => { input(thinking(), "porque sí"); });
		assert.equal(track().getAttribute("data-chosen"), "false", "editing the thinking empties it");

		act(() => { send().click(); });
		assert.equal(sent.length, 0, "no send without a stated confidence");
		assert.ok(document.querySelector('[data-testid="question-dock"]')?.textContent?.includes("Elige tu seguridad") || document.querySelector('[data-testid="question-dock"]')?.textContent?.includes("Pick your confidence"));

		act(() => { input(range(), "100"); });
		act(() => { send().click(); });
		assert.equal(sent.length, 1);
	} finally {
		cleanup();
	}
});
