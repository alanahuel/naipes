/** Image attachments (owner, 2026-11-06 — phase 1): the input-event
 *  contract, the model-facing seam, the store + routes, session deletion,
 *  the Markdown/summary markers and the view projection. An isolated
 *  temporary data dir (NP_DATA_DIR set before any import); synthetic
 *  JPEG headers only — no real data. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "np-attachments-"));
process.env.NP_DATA_DIR = DIR;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const core = await import("../src/core/index.ts");
const { attachmentStore } = await import("../src/store/attachments.ts");
const { imageResolverFor, resolveAttachments, referencedAttachmentIds } = await import("../src/server/attachments.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const uploadRoute = await import("../app/api/chats/[id]/attachments/route.ts");
const fileRoute = await import("../app/api/chats/[id]/attachments/[attId]/route.ts");

const {
	ChatInputError,
	IMAGE_ATTACHED_MARKDOWN,
	IMAGE_OMITTED_TEXT,
	IMAGE_UNAVAILABLE_TEXT,
	MAX_ATTACHMENTS,
	inputAppends,
	jpegSize,
	newAnswerResult,
	newThinkingMessage,
	newUserMessage,
	parseChatInput,
	parseUserSteerInput,
	projectView,
	serializeForSummary,
	sessionMarkdown,
	toLlmMessages,
} = core;

/** A minimal JPEG: SOI, an APP0 segment, SOF0 with the size, EOI. */
function fakeJpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
	const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
	const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
	return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

const ref = (id: string) => ({ id, mimeType: "image/jpeg" as const, width: 1600, height: 1200 });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `att_test${i}abcd`);

describe("jpegSize — the header read behind every ref", () => {
	it("reads the SOF dimensions past other segments", () => {
		assert.deepEqual(jpegSize(fakeJpeg(2000, 1500)), { width: 2000, height: 1500 });
	});
	it("refuses non-JPEG bytes (the upload route's format gate)", () => {
		assert.equal(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), null);
		assert.equal(jpegSize(new Uint8Array([0xff, 0xd8])), null);
	});
});

describe("input events carry attachmentIds", () => {
	it("text, thinking, answer and steer accept up to four ids; image-only text is allowed", () => {
		assert.deepEqual(parseChatInput({ type: "text", text: "", attachmentIds: ids(1) }), { type: "text", text: "", attachmentIds: ids(1) });
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p1", text: " ", attachmentIds: ids(2) }), {
			type: "thinking",
			problemCallId: "p1",
			text: " ",
			attachmentIds: ids(2),
		});
		const answer = parseChatInput({ type: "answer", toolCallId: "c1", answer: { kind: "ask" }, attachmentIds: ids(MAX_ATTACHMENTS) });
		assert.deepEqual((answer as { attachmentIds?: string[] }).attachmentIds, ids(MAX_ATTACHMENTS));
		assert.deepEqual(parseUserSteerInput({ type: "steer", id: "steer_1", text: "", attachmentIds: ids(1) }).attachmentIds, ids(1));
	});
	it("empty text without images is still the honest 400", () => {
		assert.throws(() => parseChatInput({ type: "text", text: "  " }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "text", text: "", attachmentIds: [] }), ChatInputError);
	});
	it("refuses more than four, duplicates, and malformed (path-unsafe) ids", () => {
		assert.throws(() => parseChatInput({ type: "text", text: "x", attachmentIds: ids(MAX_ATTACHMENTS + 1) }), /at most 4/);
		assert.throws(() => parseChatInput({ type: "text", text: "x", attachmentIds: [ids(1)[0], ids(1)[0]] }), /unique/);
		assert.throws(() => parseChatInput({ type: "text", text: "x", attachmentIds: ["../../etc/passwd"] }), ChatInputError);
	});
	it("inputAppends stamps the resolved refs on the appended message", () => {
		const [user] = inputAppends({ messages: [] }, { type: "text", text: "mira", attachmentIds: ids(1) }, [ref(ids(1)[0]!)]);
		assert.deepEqual((user as { attachments?: unknown }).attachments, [ref(ids(1)[0]!)]);
		const [plain] = inputAppends({ messages: [] }, { type: "text", text: "sin foto" });
		assert.equal("attachments" in plain!, false, "no refs → the pre-attachment shape, byte-identical");
	});
});

describe("toLlmMessages — refs become image content at the wire", () => {
	const image = { type: "image" as const, data: "QUJD", mimeType: "image/jpeg" };
	const resolve = () => image;
	it("a user message keeps its text first, then one block per image; the refs never reach the wire", () => {
		const [wire] = toLlmMessages([newUserMessage("mis pasos", [ref("att_aaaaaa1"), ref("att_aaaaaa2")])] as never, resolve);
		assert.deepEqual((wire as { content: unknown }).content, [{ type: "text", text: "mis pasos" }, image, image]);
		assert.equal("attachments" in wire!, false);
		assert.equal("id" in wire!, false);
	});
	it("an image-only message sends no empty text block", () => {
		const [wire] = toLlmMessages([newUserMessage("", [ref("att_aaaaaa1")])] as never, resolve);
		assert.deepEqual((wire as { content: unknown }).content, [image]);
	});
	it("practice thinking and answers carry their images too", () => {
		const thinking = newThinkingMessage("p1", "paso 1", 70, [ref("att_aaaaaa1")]);
		const answer = newAnswerResult("c1", "ask_user_question", { kind: "ask", text: "x" }, [ref("att_aaaaaa2")]);
		const [t, a] = toLlmMessages([thinking, answer] as never, resolve);
		assert.deepEqual((t as { content: unknown[] }).content.at(-1), image);
		assert.deepEqual((a as { content: unknown[] }).content.at(-1), image);
	});
	it("without a resolver every image reads as omitted (nothing unverified reaches a provider)", () => {
		const [wire] = toLlmMessages([newUserMessage("x", [ref("att_aaaaaa1")])] as never);
		assert.deepEqual((wire as { content: unknown[] }).content.at(-1), { type: "text", text: IMAGE_OMITTED_TEXT });
	});
	it("a throwing resolver never kills the loop", () => {
		const [wire] = toLlmMessages([newUserMessage("x", [ref("att_aaaaaa1")])] as never, () => {
			throw new Error("boom");
		});
		assert.deepEqual((wire as { content: unknown[] }).content.at(-1), { type: "text", text: IMAGE_OMITTED_TEXT });
	});
	it("messages without attachments pass through untouched", () => {
		const message = newUserMessage("hola");
		const [wire] = toLlmMessages([message] as never, resolve);
		assert.equal((wire as { content: unknown }).content, "hola");
	});
});

describe("the store, the server resolver and the routes", () => {
	const chat = chatStore.createChat("Matemáticas");
	const post = (bytes: Uint8Array<ArrayBuffer>, chatId = chat.id) =>
		uploadRoute.POST(new Request("http://x/api", { method: "POST", body: bytes, headers: { "Content-Type": "image/jpeg" } }), {
			params: Promise.resolve({ id: chatId }),
		});

	it("POST stores a JPEG under attachments/<chatId>/ and returns its ref", async () => {
		const res = await post(fakeJpeg(1800, 900));
		assert.equal(res.status, 201);
		const { attachment } = (await res.json()) as { attachment: { id: string; width: number; height: number } };
		assert.equal(attachment.width, 1800);
		assert.equal(attachment.height, 900);
		assert.ok(fs.existsSync(path.join(DIR, "attachments", chat.id, `${attachment.id}.jpg`)));
		const got = await fileRoute.GET(new Request("http://x"), { params: Promise.resolve({ id: chat.id, attId: attachment.id }) });
		assert.equal(got.status, 200);
		assert.equal(got.headers.get("content-type"), "image/jpeg");
	});
	it("POST refuses non-JPEG bodies (415) and unknown chats (404)", async () => {
		assert.equal((await post(new Uint8Array([1, 2, 3, 4]))).status, 415);
		assert.equal((await post(fakeJpeg(10, 10), "chat_nope")).status, 404);
	});
	it("resolveAttachments 400s an id from another chat; the resolver reads files for vision models only", () => {
		const saved = attachmentStore.save(chat.id, fakeJpeg(100, 50))!;
		assert.deepEqual(resolveAttachments(chat.id, [saved.id]), [saved]);
		const other = chatStore.createChat("Otra");
		assert.throws(() => resolveAttachments(other.id, [saved.id]), ChatInputError);

		const block = imageResolverFor(chat.id, true)(saved);
		assert.equal(block.type, "image");
		assert.equal((block as { data: string }).data, Buffer.from(fakeJpeg(100, 50)).toString("base64"));
		assert.deepEqual(imageResolverFor(chat.id, false)(saved), { type: "text", text: IMAGE_OMITTED_TEXT });
		assert.deepEqual(imageResolverFor(chat.id, true)({ ...saved, id: "att_missing000" }), { type: "text", text: IMAGE_UNAVAILABLE_TEXT });
	});
	it("DELETE drops an unsent image, but a sent one belongs to the record (409)", async () => {
		const unsent = attachmentStore.save(chat.id, fakeJpeg(10, 10))!;
		const sent = attachmentStore.save(chat.id, fakeJpeg(10, 10))!;
		chatStore.saveMessages(chat.id, [newUserMessage("", [sent])]);
		assert.ok(referencedAttachmentIds(chatStore.getChat(chat.id)!.messages).has(sent.id));
		const del = (attId: string) => fileRoute.DELETE(new Request("http://x"), { params: Promise.resolve({ id: chat.id, attId }) });
		assert.equal((await del(sent.id)).status, 409);
		assert.equal((await del(unsent.id)).status, 200);
		assert.equal(attachmentStore.read(chat.id, unsent.id), null);
		assert.equal((await del(unsent.id)).status, 404);
	});
	it("deleting the session removes its attachment folder", async () => {
		const doomed = chatStore.createChat("Borrar");
		attachmentStore.save(doomed.id, fakeJpeg(10, 10));
		assert.ok(fs.existsSync(path.join(DIR, "attachments", doomed.id)));
		const outcome = await deleteChatSession(doomed.id, "preserve-graph");
		assert.equal(outcome.ok, true);
		assert.equal(fs.existsSync(path.join(DIR, "attachments", doomed.id)), false);
	});
});

describe("background readers see a marker, the view sees refs", () => {
	it("session Markdown marks each image (image-only messages included)", () => {
		const md = sessionMarkdown([newUserMessage("mis pasos", [ref("att_aaaaaa1")]), newUserMessage("", [ref("att_aaaaaa2"), ref("att_aaaaaa3")])], {
			anchors: false,
		});
		assert.match(md, new RegExp(`mis pasos\\n\\n${IMAGE_ATTACHED_MARKDOWN.replace(/[*[\]]/g, "\\$&")}`));
		assert.equal(md.split(IMAGE_ATTACHED_MARKDOWN).length - 1, 3);
	});
	it("the compaction summary notes images on the message's own line", () => {
		const text = serializeForSummary([newUserMessage("hola", [ref("att_aaaaaa1")]), newUserMessage("", [ref("att_aaaaaa2")])]);
		assert.equal(text, "[LEARNER] hola [image attached]\n\n[LEARNER]  [image attached]");
	});
	it("projectView: user refs on the view message, thinking refs in the card data, answer refs in the output", () => {
		const call = { id: "a1", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "ask_user_question", arguments: { question: "q" } }], stopReason: "toolUse", timestamp: 1 };
		const view = projectView([
			newUserMessage("", [ref("att_aaaaaa1")]),
			newThinkingMessage("p1", "paso", undefined, [ref("att_aaaaaa2")]),
			call as never,
			newAnswerResult("c1", "ask_user_question", { kind: "ask", text: "x" }, [ref("att_aaaaaa3")]),
		] as never);
		assert.deepEqual(view[0]!.attachments, [ref("att_aaaaaa1")]);
		assert.equal(view[0]!.parts.length, 0, "an image-only message projects no empty text part");
		assert.deepEqual((view[1]!.parts[0] as { data: { attachments: unknown } }).data.attachments, [ref("att_aaaaaa2")]);
		const toolPart = view[2]!.parts.find((p) => p.type === "tool-ask_user_question") as { output: { attachments: unknown } };
		assert.deepEqual(toolPart.output.attachments, [ref("att_aaaaaa3")]);
	});
});

describe("optimistic absorption keys on the images too", async () => {
	const { absorbed } = await import("../components/session-core.ts");
	it("an image-only optimistic bubble is absorbed only by the record copy with the same ids", () => {
		const local = { ...newUserMessage("", [ref("att_aaaaaa1")]), id: "c_local1" };
		assert.equal(absorbed(local as never, [newUserMessage("", [ref("att_aaaaaa1")])] as never), true);
		assert.equal(absorbed(local as never, [newUserMessage("", [ref("att_aaaaaa2")])] as never), false);
		assert.equal(absorbed(local as never, [newUserMessage("")] as never), false);
	});
});
