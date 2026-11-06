/**
 * Image attachments, server side (owner, 2026-11-06): resolving an input
 * event's attachmentIds against the chat's folder, and the ImageResolver
 * the agent's convertToLlm uses to turn refs into native image content.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { attachmentsOf, IMAGE_OMITTED_TEXT, IMAGE_UNAVAILABLE_TEXT, type AttachmentRef } from "../core/attachments.ts";
import { ChatInputError } from "../core/input-events.ts";
import type { ImageResolver, NpMessage } from "../core/native-messages.ts";
import { stores } from "./stores.ts";

/** The refs for an input's ids, in order — an id with no file in THIS
 *  chat's folder is the honest 400 (never a silently dropped image). */
export function resolveAttachments(chatId: string, ids: readonly string[]): AttachmentRef[] {
	return ids.map((id) => {
		const ref = stores.attachmentStore.ref(chatId, id);
		if (!ref) throw new ChatInputError(`unknown attachment: ${id}`);
		return ref;
	});
}

/** Every attachment id the record references (a sent image is never
 *  deletable on its own — it goes with the session). */
export function referencedAttachmentIds(messages: readonly NpMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) for (const ref of attachmentsOf(m)) ids.add(ref.id);
	return ids;
}

/** The turn's resolver: native image content for a vision model (the
 *  file read once per turn, cached), a text stand-in otherwise. */
export function imageResolverFor(chatId: string, vision: boolean): ImageResolver {
	const cache = new Map<string, ImageContent | TextContent>();
	return (ref) => {
		if (!vision) return { type: "text", text: IMAGE_OMITTED_TEXT };
		const hit = cache.get(ref.id);
		if (hit) return hit;
		const bytes = stores.attachmentStore.read(chatId, ref.id);
		const block: ImageContent | TextContent = bytes
			? { type: "image", data: bytes.toString("base64"), mimeType: ref.mimeType }
			: { type: "text", text: IMAGE_UNAVAILABLE_TEXT };
		cache.set(ref.id, block);
		return block;
	};
}

/** Does this model accept image input (pi's catalog `input` list)? */
export function modelHasVision(model: { input?: readonly string[] }): boolean {
	return Array.isArray(model.input) && model.input.includes("image");
}
