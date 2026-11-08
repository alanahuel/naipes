/**
 * build-mcp.mjs — bundle the MCP stdio server (src/mcp/main.ts) into ONE
 * self-contained ESM file (owner, 2026-11-08). The packaged app runs it as
 * Node (`naipes --mcp` → ELECTRON_RUN_AS_NODE, electron/main.cjs), so it
 * must need nothing from node_modules at runtime.
 *
 *   node scripts/build-mcp.mjs [outfile]
 *
 * Default outfile: .next/standalone/mcp/naipes-mcp.mjs — beside the server,
 * so electron-builder's existing `.next → server` copy ships it. Run AFTER
 * build-server.mjs (every packaging pipeline: install-linux.sh, ci.yml,
 * release.yml, desktop:dist).
 *
 * ESM output keeps config.ts's import.meta.url working; the banner gives
 * bundled CommonJS dependencies a real `require` for Node built-ins.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");

export async function buildMcp(outfile) {
	const result = await build({
		entryPoints: [path.join(ROOT, "src", "mcp", "main.ts")],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		banner: { js: 'import { createRequire as __npCreateRequire } from "node:module"; const require = __npCreateRequire(import.meta.url);' },
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
	});
	// The read side must never drag in the server/agent layers (and their
	// native modules): the lint zone forbids it; this makes a leak loud.
	const leaked = Object.keys(result.metafile.inputs).filter((p) => /(^|\/)src\/(server|agent)\//.test(p) || /\.node$/.test(p));
	if (leaked.length > 0) {
		console.error("[build-mcp] REFUSING: the MCP bundle pulled in", leaked);
		process.exit(1);
	}
	console.log("[build-mcp] MCP server bundled:", outfile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await buildMcp(path.resolve(process.argv[2] ?? path.join(ROOT, ".next", "standalone", "mcp", "naipes-mcp.mjs")));
}
