import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	actionForBinding,
	bindingForAction,
	formatBinding,
	IS_MAC,
	kbdEventForAction,
	KEYBOARD_ACTIONS,
} from "../src/core/keyboard.ts";
import { kbdEventForAction as kbdEventForActionFromUi } from "../components/keyboard-shortcuts.tsx";

/**
 * The one spelling for action events (born from the ⌘B sidebar bug, owner
 * 2026-09-25): dispatcher and listeners compose the event name through the
 * ONE helper. Stage 3 (Naipes interface) retired the sidebar and its ⌘B;
 * the tabs took ⌘1/⌘2/⌘3.
 */

describe("kbdEventForAction — the one spelling for action events", () => {
	it("dispatch and listen names are the helper's output", () => {
		assert.equal(kbdEventForAction("go-home"), "np:kbd-go-home");
		assert.equal(kbdEventForAction("sessions-search"), "np:kbd-sessions-search");
	});

	it("the dispatcher imports the same helper (no second spelling exists)", () => {
		assert.equal(kbdEventForActionFromUi, kbdEventForAction);
	});
});

describe("the tabs — keypress → binding → action", () => {
	it("mod+t is the toggle-user-thinking action (owner round, 2026-10-07)", () => {
		assert.equal(actionForBinding("mod+t"), "toggle-user-thinking");
		assert.equal(bindingForAction("toggle-user-thinking"), "mod+t");
	});

	it("mod+1/2/3 open Inicio, Mis sesiones and Conocimiento", () => {
		assert.equal(actionForBinding("mod+1"), "go-home");
		assert.equal(actionForBinding("mod+2"), "go-sessions");
		assert.equal(actionForBinding("mod+3"), "go-knowledge");
		assert.equal(formatBinding("mod+1"), IS_MAC ? "⌘1" : "Ctrl+1");
	});

	it("the sidebar toggle is gone: mod+b binds to nothing", () => {
		assert.equal(actionForBinding("mod+b") ?? null, null);
		assert.ok(!KEYBOARD_ACTIONS.some((a) => (a.id as string) === "toggle-sidebar"));
	});
});

describe("the thinking pill suffix — ⇧⇥ via the registry", () => {
	it("shift+tab uses the platform's modifier label and maps to cycle-thinking", () => {
		assert.equal(actionForBinding("shift+tab"), "cycle-thinking");
		assert.equal(formatBinding("shift+tab"), IS_MAC ? "⇧⇥" : "Shift+⇥");
	});
});

describe("the Alt session cycle is RETIRED (owner, 2026-10-10)", () => {
	// Barely used, felt laggy — session navigation lives IN the search
	// now (↑/↓ walk the filtered list, Enter opens; sessions.tsx).
	it("⌥↑ / ⌥↓ / ⌥↵ bind to NOTHING — no stray action fires", () => {
		assert.equal(actionForBinding("alt+arrowup") ?? null, null);
		assert.equal(actionForBinding("alt+arrowdown") ?? null, null);
		assert.equal(actionForBinding("alt+enter") ?? null, null);
	});

	it("the actions are gone from the table (cheat sheet + settings render the registry)", () => {
		const ids = KEYBOARD_ACTIONS.map((a) => a.id as string);
		assert.ok(!ids.includes("cycle-session-prev"));
		assert.ok(!ids.includes("cycle-session-next"));
		assert.ok(!ids.includes("open-session"));
	});
});