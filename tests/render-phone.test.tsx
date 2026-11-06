/** «Enviar desde el móvil», client chrome (owner, 2026-11-06 — phase 2):
 *  the phone button beside the clip only with the setting on, disabled
 *  like the clip without vision; the panel's countdown format. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachButton, useAttachmentTray } from "../components/attachments.tsx";
import { countdown } from "../components/phone-overlay.tsx";

function Tray({ phone, vision }: { phone: boolean; vision: boolean }) {
	const tray = useAttachmentTray({ chatId: "chat_x", vision, phone, openPhone: () => {} });
	return <AttachButton tray={tray} />;
}

describe("the phone button", () => {
	it("is absent while the setting is off", () => {
		assert.doesNotMatch(renderToStaticMarkup(<Tray phone={false} vision />), /data-testid="phone-button"/);
	});
	it("sits beside the clip when on, live for a vision model", () => {
		const html = renderToStaticMarkup(<Tray phone vision />);
		assert.match(html, /data-testid="attach-button"/);
		assert.match(html, /data-testid="phone-button"/);
		assert.doesNotMatch(html, /data-testid="phone-button"[^>]*disabled=""/);
		assert.match(html, /(desde el móvil|from your phone)/);
	});
	it("is disabled without vision, saying why", () => {
		const html = renderToStaticMarkup(<Tray phone vision={false} />);
		assert.match(html, /data-testid="phone-button"[^>]*disabled=""/);
	});
});

describe("countdown", () => {
	it("reads m:ss and never goes negative", () => {
		assert.equal(countdown(600_000), "10:00");
		assert.equal(countdown(61_500), "1:02");
		assert.equal(countdown(-5), "0:00");
	});
});
