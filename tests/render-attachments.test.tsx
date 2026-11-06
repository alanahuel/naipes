/** Image attachments, client side (owner, 2026-11-06 — phase 1): the
 *  pure file gates, the tray chrome (clip live vs. the no-vision notice),
 *  and the history thumbnails in the bubble, thinking card and answer. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AttachButton,
	AttachmentsContext,
	AttachmentThumbs,
	attachmentKind,
	attachmentUrl,
	fitWithin,
	useAttachmentTray,
} from "../components/attachments.tsx";
import { Composer } from "../components/composer.tsx";
import { ThinkingCard } from "../components/practice-cards.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { QueuedSteersBody } from "../components/queued-steers.tsx";

const ref = (id: string) => ({ id, mimeType: "image/jpeg" as const, width: 1600, height: 1200 });
const scope = (vision: boolean) => ({ chatId: "chat_x", vision, openImage: () => {} });

describe("the pure file gates", () => {
	it("accepts JPG/PNG/WebP, names HEIC (the «export as JPEG» notice), refuses the rest", () => {
		assert.equal(attachmentKind({ type: "image/jpeg", name: "a.jpg" }), "ok");
		assert.equal(attachmentKind({ type: "image/png", name: "a.png" }), "ok");
		assert.equal(attachmentKind({ type: "image/webp", name: "a.webp" }), "ok");
		assert.equal(attachmentKind({ type: "image/heic", name: "IMG_1.HEIC" }), "heic");
		assert.equal(attachmentKind({ type: "", name: "IMG_2.heic" }), "heic", "Linux often reports HEIC with no type");
		assert.equal(attachmentKind({ type: "image/gif", name: "a.gif" }), "unsupported");
		assert.equal(attachmentKind({ type: "application/pdf", name: "a.pdf" }), "unsupported");
	});
	it("fits the longest side to 2000 px and never upscales", () => {
		assert.deepEqual(fitWithin(4032, 3024), { width: 2000, height: 1500 });
		assert.deepEqual(fitWithin(3024, 4032), { width: 1500, height: 2000 });
		assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
	});
	it("serves attachments from the chat's own route", () => {
		assert.equal(attachmentUrl("chat_x", "att_abc123"), "/api/chats/chat_x/attachments/att_abc123");
	});
});

function ComposerWithTray({ vision }: { vision: boolean }) {
	const tray = useAttachmentTray(scope(vision));
	return <Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} tray={tray} />;
}

describe("the tray chrome", () => {
	it("a vision model gets a live clip button with a multi-file picker", () => {
		const html = renderToStaticMarkup(<ComposerWithTray vision />);
		assert.match(html, /data-testid="attach-button"/);
		assert.doesNotMatch(html, /data-testid="attach-button"[^>]*disabled=""/);
		assert.match(html, /type="file"[^>]*multiple/);
	});
	it("a model without vision disables the clip, its tooltip saying why", () => {
		const html = renderToStaticMarkup(<ComposerWithTray vision={false} />);
		assert.match(html, /data-testid="attach-button"[^>]*disabled=""/);
		assert.match(html, /(no ve imágenes|can&#x27;t see images)/);
	});
	it("outside a chat page (no scope) there is no clip at all", () => {
		function Bare() {
			const tray = useAttachmentTray();
			return <AttachButton tray={tray} />;
		}
		assert.equal(renderToStaticMarkup(<Bare />), "");
	});
});

describe("history thumbnails", () => {
	it("render one button per image, served by the chat's route", () => {
		const html = renderToStaticMarkup(
			<AttachmentsContext.Provider value={scope(true)}>
				<AttachmentThumbs refs={[ref("att_aaaaaa1"), ref("att_aaaaaa2")]} />
			</AttachmentsContext.Provider>,
		);
		assert.equal(html.match(/<img/g)?.length, 2);
		assert.match(html, /src="\/api\/chats\/chat_x\/attachments\/att_aaaaaa1"/);
	});
	it("the thinking card shows its images; an image-only submission drops the empty row", () => {
		const html = renderToStaticMarkup(
			<AttachmentsContext.Provider value={scope(true)}>
				<ThinkingCard data={{ problemCallId: "p1", text: "", attachments: [ref("att_aaaaaa1")] }} />
			</AttachmentsContext.Provider>,
		);
		assert.match(html, /data-testid="attachment-thumbs"/);
		assert.doesNotMatch(html, /data-testid="thinking-card"/);
	});
	it("the answered card shows the answer's images under the text", () => {
		const html = renderToStaticMarkup(
			<AttachmentsContext.Provider value={scope(true)}>
				<AnsweredCard answer={{ kind: "ask", questionText: "¿Y el paso 3?", dontKnow: false, answers: [], text: "mira", answeredAt: "2026-11-06T10:00:00.000Z", attachments: [ref("att_aaaaaa1")] }} />
			</AttachmentsContext.Provider>,
		);
		assert.match(html, /mira/);
		assert.match(html, /attachments\/att_aaaaaa1/);
	});
	it("an image-only steer still gets its queued line", () => {
		const html = renderToStaticMarkup(<QueuedSteersBody steers={[{ id: "steer_a", text: "" }]} />);
		assert.match(html, /\((imagen|image)\)/);
	});
});
