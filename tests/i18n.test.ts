import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOCALE, LOCALES, formatMessage, isLocale, placeholdersOf } from "../src/core/i18n.ts";
import { MESSAGES } from "../src/core/messages/index.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";

describe("interface dictionaries", () => {
	const es = MESSAGES.es;
	const en = MESSAGES.en;

	it("Spanish is the default and both languages carry the same keys", () => {
		assert.equal(DEFAULT_LOCALE, "es");
		assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
	});

	it("every message keeps the same placeholders and plural shape in both languages", () => {
		for (const key of Object.keys(es) as Array<keyof typeof es>) {
			assert.deepEqual(placeholdersOf(en[key]), placeholdersOf(es[key]), `placeholders of ${key}`);
			assert.equal(typeof en[key], typeof es[key], `plural shape of ${key}`);
		}
	});

	it("no message is empty and keys follow «zona.queDice»", () => {
		for (const locale of LOCALES) {
			for (const [key, message] of Object.entries(MESSAGES[locale])) {
				assert.match(key, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, key);
				const texts = typeof message === "string" ? [message] : [message.one, message.other];
				for (const text of texts) assert.ok(text.trim().length > 0, `${locale} ${key} is empty`);
			}
		}
	});
});

describe("formatMessage", () => {
	it("fills placeholders and leaves unknown ones visible", () => {
		assert.equal(formatMessage("Hola, {name}", { name: "Alan" }), "Hola, Alan");
		assert.equal(formatMessage("Paso {step} de {total}", { step: 3 }), "Paso 3 de {total}");
	});

	it("picks the plural form by n, per language", () => {
		const msg = { one: "{n} sesión", other: "{n} sesiones" };
		assert.equal(formatMessage(msg, { n: 1 }, "es"), "1 sesión");
		assert.equal(formatMessage(msg, { n: 0 }, "es"), "0 sesiones");
		assert.equal(formatMessage(msg, { n: 5 }, "es"), "5 sesiones");
		assert.equal(formatMessage({ one: "{n} session", other: "{n} sessions" }, { n: 1 }, "en"), "1 session");
	});
});

describe("the language setting", () => {
	it("defaults to Spanish and accepts only known languages", () => {
		assert.equal(resolveSettings(null).general.language, "es");
		assert.ok(isLocale("en") && !isLocale("fr"));
		assert.equal(sanitizeUserSettings({ version: 1, general: { language: "en" } })?.general?.language, "en");
		assert.equal(sanitizeUserSettings({ version: 1, general: { language: "fr" } })?.general?.language, undefined);
		assert.equal(parseGeneralSettingsBody({ language: "en" }).ok, true);
		assert.equal(parseGeneralSettingsBody({ language: "fr" }).ok, false);
	});
});
