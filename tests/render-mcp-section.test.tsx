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
