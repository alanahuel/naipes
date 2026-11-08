/** Settings → «Conexión MCP» (owner, 2026-11-08): SSR must not touch
 *  `window` (the launch command arrives from the shell in an effect, which
 *  never fires under renderToStaticMarkup — the SSR state IS the loading
 *  state: the intro, no snippet, no «unavailable» note yet). */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { McpSection } from "../components/settings/mcp-section.tsx";

describe("MCP settings section", () => {
	it("renders server-side without the desktop bridge; writing off by default", () => {
		const html = renderToStaticMarkup(<McpSection mcp={undefined} onChange={() => {}} />);
		assert.match(html, /MCP/);
		assert.match(html, /data-testid="mcp-enabled"/);
		assert.doesNotMatch(html, /mcp-claude-code|mcp-unavailable|mcp-port|mcp-regenerate/);
	});

	it("writing on: the port and «Regenerar token» rows appear", () => {
		const html = renderToStaticMarkup(<McpSection mcp={{ enabled: true, port: 47900 }} onChange={() => {}} />);
		assert.match(html, /value="47900"/);
		assert.match(html, /data-testid="mcp-regenerate"/);
	});
});

const { McpDeletionBody } = await import("../components/mcp-deletion-host.tsx");
const view = (kind: "session" | "exam" | "proposition") => ({ id: "r1", kind, targetId: "x", label: "Estoicismo", client: "claude-code", suggestTraces: true, expiresAt: 0 });
const noop = () => {};

describe("MCP deletion confirmation", () => {
	it("a session: who asks, what, and the traces box at the suggestion", () => {
		const html = renderToStaticMarkup(<McpDeletionBody request={view("session")} waiting={2} traces={true} busy={false} failure={null} onTraces={noop} onReject={noop} onDelete={noop} />);
		assert.match(html, /claude-code/);
		assert.match(html, /Estoicismo/);
		assert.match(html, /data-testid="mcp-deletion-traces-checkbox"[^>]*checked=""|checked=""[^>]*data-testid="mcp-deletion-traces-checkbox"/);
		assert.match(html, /data-testid="mcp-deletion-reject"/);
		assert.match(html, /data-testid="mcp-deletion-confirm"/);
	});

	it("an exam or a proposition: no traces box; a failure shows its reason", () => {
		for (const kind of ["exam", "proposition"] as const) {
			const html = renderToStaticMarkup(<McpDeletionBody request={view(kind)} waiting={0} traces={false} busy={false} failure="A turn is running" onTraces={noop} onReject={noop} onDelete={noop} />);
			assert.doesNotMatch(html, /mcp-deletion-traces/);
			assert.match(html, /A turn is running/);
		}
	});
});
