/**
 * Knowledge-folder file resolution for np:open-source (phase 2, owner
 * 2026-11-04): Conocimiento opens an idea's document with the system viewer.
 * Only a regular file of a readable kind INSIDE the configured folder
 * (settings.json → obsidian.vaultPath) resolves — realpath-checked, so
 * neither ".." nor a symlink can reach outside it.
 */
const fs = require("node:fs");
const path = require("node:path");

/** The file kinds the knowledge folder reads (mirrors src/server/doc-text.ts). */
const KNOWLEDGE_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".docx", ".epub"]);

/** The absolute path of `relPath` inside the knowledge folder, or null. */
function knowledgeSourcePath(dataDir, relPath) {
	if (typeof relPath !== "string" || relPath === "" || path.isAbsolute(relPath)) return null;
	let root;
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8"));
		root = settings?.obsidian?.vaultPath;
	} catch {
		return null;
	}
	if (typeof root !== "string" || !path.isAbsolute(root)) return null;
	try {
		const realRoot = fs.realpathSync(root);
		const target = fs.realpathSync(path.join(realRoot, relPath));
		if (!target.startsWith(realRoot + path.sep)) return null;
		if (!fs.statSync(target).isFile()) return null;
		if (!KNOWLEDGE_EXTENSIONS.has(path.extname(target).toLowerCase())) return null;
		return target;
	} catch {
		return null;
	}
}

module.exports = { knowledgeSourcePath, KNOWLEDGE_EXTENSIONS };
