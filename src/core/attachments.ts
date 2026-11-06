/**
 * IMAGE ATTACHMENTS (owner, 2026-11-06 — «Imágenes adjuntas», phase 1):
 * the learner can attach up to four photos (handwritten working, a
 * screenshot) to a composer message, a steer, a practice-thinking
 * submission or a text answer. Owner decisions:
 *
 * - Files live OUTSIDE the record: data/attachments/<chatId>/<id>.jpg
 *   (src/store/attachments.ts). A record message carries only refs in
 *   its `attachments` field — the record stays small.
 * - Every image is a JPEG, longest side ≤ 2000 px, re-encoded client-side
 *   (components/attachments.tsx); the original is never kept.
 * - The MODEL sees the image natively (toLlmMessages + an ImageResolver);
 *   a model without vision input reads IMAGE_OMITTED_TEXT instead.
 * - Background readers (extraction, exam plan, review — the session
 *   Markdown engine) see only IMAGE_ATTACHED_MARKDOWN.
 *
 * Pure: types, limits, id validation, and the JPEG header read the
 * store and the tests share.
 */

/** One attached image, as the record references it. */
export interface AttachmentRef {
	/** `att_<random>` — also the file's basename. */
	id: string;
	mimeType: "image/jpeg";
	width: number;
	height: number;
}

/** At most this many images per message (owner, 2026-11-06). */
export const MAX_ATTACHMENTS = 4;

/** The client resize target: longest side in px (owner, 2026-11-06). */
export const ATTACHMENT_MAX_SIDE = 2000;

/** The client JPEG quality (owner, 2026-11-06: ~85). */
export const ATTACHMENT_JPEG_QUALITY = 0.85;

/** The upload route's byte ceiling — a resized 2000 px JPEG is far below. */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/** Formats the client accepts before re-encoding (HEIC is refused with
 *  an «export as JPEG» notice — Chromium cannot decode it). */
export const ATTACHMENT_ACCEPT = ["image/jpeg", "image/png", "image/webp"] as const;

const ID_RE = /^att_[a-z0-9]{6,40}$/;

/** Is this a well-formed attachment id (path-safe by construction)? */
export function isAttachmentId(id: unknown): id is string {
	return typeof id === "string" && ID_RE.test(id);
}

/** A fresh attachment id. */
export function newAttachmentId(): string {
	return `att_${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** The model-facing stand-in when the session's model has no image input. */
export const IMAGE_OMITTED_TEXT = "[image omitted — the current model cannot see images]";

/** The model-facing stand-in when the file is gone from disk. */
export const IMAGE_UNAVAILABLE_TEXT = "[image unavailable]";

/** What the session Markdown (the background readers' view) shows. */
export const IMAGE_ATTACHED_MARKDOWN = "*[image attached]*";

/** A message's attachment refs (absent → empty). */
export function attachmentsOf(message: unknown): AttachmentRef[] {
	const refs = (message as { attachments?: unknown } | null)?.attachments;
	return Array.isArray(refs) ? (refs as AttachmentRef[]) : [];
}

/** Read a JPEG's pixel size from its SOF header — null when the bytes are
 *  not a JPEG. Doubles as the upload route's format check. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let i = 2;
	while (i + 9 < bytes.length) {
		if (bytes[i] !== 0xff) return null;
		const marker = bytes[i + 1]!;
		// Fill bytes / standalone markers carry no length.
		if (marker === 0xff) {
			i++;
			continue;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2;
			continue;
		}
		const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
		// SOF0–SOF15, except DHT (c4), JPG (c8) and DAC (cc).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
			const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
			return width > 0 && height > 0 ? { width, height } : null;
		}
		if (length < 2) return null;
		i += 2 + length;
	}
	return null;
}
