/**
 * THE INTERFACE LANGUAGES (Naipes interface, stage 2 — 2026-11-03).
 *
 * Spanish is the SOURCE language (src/core/messages/es/*); English is the
 * translation (src/core/messages/en/*) and must carry exactly the same keys
 * and placeholders (type-checked per zone + tests/i18n.test.ts).
 *
 * Keys are «zona.queDice» ("session.stop", "settings.obsidian.vault").
 * A message is a plain string or a plural pair { one, other } chosen by the
 * `n` variable; {name} placeholders are filled from the vars. Only the
 * INTERFACE is translated: what the tutor writes follows the session.
 *
 * Pure — no React, no IO. The client provider lives in components/i18n.tsx.
 */

export type Locale = "es" | "en";
export const LOCALES: readonly Locale[] = ["es", "en"];
export const DEFAULT_LOCALE: Locale = "es";

/** Each locale's name in its own language (the language picker). */
export const LOCALE_NAMES: Record<Locale, string> = { es: "Español", en: "English" };

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export interface Plural {
	one: string;
	other: string;
}
export type Message = string | Plural;
export type Messages = Record<string, Message>;
export type MessageVars = Record<string, string | number>;

const PLACEHOLDER = /\{(\w+)\}/g;

/** Fill a message: pick the plural form by `n`, then replace {name}s.
 *  A missing var leaves its placeholder visible (never "undefined"). */
export function formatMessage(message: Message, vars: MessageVars = {}, locale: Locale = DEFAULT_LOCALE): string {
	let text: string;
	if (typeof message === "string") {
		text = message;
	} else {
		const n = typeof vars.n === "number" ? vars.n : Number(vars.n ?? 0);
		text = new Intl.PluralRules(locale).select(n) === "one" ? message.one : message.other;
	}
	return text.replace(PLACEHOLDER, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** The placeholder names a message uses (both plural forms), sorted. */
export function placeholdersOf(message: Message): string[] {
	const texts = typeof message === "string" ? [message] : [message.one, message.other];
	const names = new Set<string>();
	for (const text of texts) for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1]!);
	return [...names].sort();
}
