/**
 * The knowledge folder's file walk — read-only fs, shared by the vault sync
 * (src/server/vault.ts) and the MCP read side (the inbox listing while the
 * app is closed, owner 2026-11-08). Hidden entries and the app's own output
 * folder are skipped; only note files (core/vault-notes.ts) are listed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isInOutputFolder, isNoteFile } from "../core/vault-notes.ts";

/** Note files under `folder` (folder-relative, "/"-joined), recursively. */
export function scanNoteFiles(root: string, folder: string, outputFolder: string): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const child = `${rel}/${entry.name}`;
			if (isInOutputFolder(child, outputFolder)) continue;
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile() && isNoteFile(entry.name)) out.push(child);
		}
	};
	walk(folder);
	return out;
}
