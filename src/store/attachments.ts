/**
 * AttachmentStore — the fs adapter for the learner's images (owner,
 * 2026-11-06): data/attachments/<chatId>/<id>.jpg. Implements
 * core/ports.ts AttachmentStore. Sync fs and id-guarded paths, like the
 * chat store; refs are re-derived from the JPEG header, so no sidecar
 * metadata can drift from the file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { AttachmentStore } from "../core/ports.ts";
import { ATTACHMENT_MAX_BYTES, isAttachmentId, jpegSize, newAttachmentId, type AttachmentRef } from "../core/attachments.ts";

function chatDir(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(PATHS.attachments, chatId);
}

function attachmentFile(chatId: string, id: string): string | null {
	return isAttachmentId(id) ? path.join(chatDir(chatId), `${id}.jpg`) : null;
}

function refOf(id: string, bytes: Uint8Array): AttachmentRef | null {
	const size = jpegSize(bytes);
	return size ? { id, mimeType: "image/jpeg", width: size.width, height: size.height } : null;
}

export const attachmentStore: AttachmentStore = {
	save(chatId, bytes) {
		if (bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_MAX_BYTES) return null;
		const id = newAttachmentId();
		const ref = refOf(id, bytes);
		if (!ref) return null;
		fs.mkdirSync(chatDir(chatId), { recursive: true });
		fs.writeFileSync(attachmentFile(chatId, id)!, bytes);
		return ref;
	},
	ref(chatId, id) {
		const bytes = this.read(chatId, id);
		return bytes ? refOf(id, bytes) : null;
	},
	read(chatId, id) {
		const file = attachmentFile(chatId, id);
		if (!file) return null;
		try {
			return fs.readFileSync(file);
		} catch {
			return null;
		}
	},
	removeOne(chatId, id) {
		const file = attachmentFile(chatId, id);
		if (!file) return false;
		try {
			fs.unlinkSync(file);
			return true;
		} catch {
			return false;
		}
	},
	removeChat(chatId) {
		fs.rmSync(chatDir(chatId), { recursive: true, force: true });
	},
};
