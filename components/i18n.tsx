"use client";
/**
 * THE INTERFACE LANGUAGE on the client (stage 2, 2026-11-03).
 *
 *   const t = useT();
 *   t("session.stop")                       → "Parar"
 *   t("sessions.count", { n: 3 })            → "3 sesiones"
 *
 * The root layout reads the settings record on the server and mounts
 * <I18nProvider initialLocale=…>, so the first paint is already in the
 * right language; changing it in Settings calls setLocale and every
 * component re-renders in place.
 *
 * Outside a provider (render tests that mount a component alone) the
 * context falls back to ENGLISH: the suites keep asserting the English
 * copy, and tests/i18n.test.ts checks the Spanish dictionary separately.
 * The app itself always runs inside the provider (default Spanish).
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { MESSAGES, formatMessage, type Locale, type MessageKey, type MessageVars } from "@/src/core";

export type Translate = (key: MessageKey, vars?: MessageVars) => string;

interface I18nContextValue {
	locale: Locale;
	setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue>({ locale: "en", setLocale: () => {} });

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: React.ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(initialLocale);
	const setLocale = useCallback((next: Locale) => {
		setLocaleState(next);
		document.documentElement.lang = next;
	}, []);
	const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The current interface language and its setter. */
export function useLocale(): I18nContextValue {
	return useContext(I18nContext);
}

/** A pure translator for a locale (for helpers outside React). */
export function translator(locale: Locale): Translate {
	const dict = MESSAGES[locale];
	return (key, vars) => formatMessage(dict[key] ?? key, vars, locale);
}

/** The translator for the current interface language. */
export function useT(): Translate {
	const { locale } = useContext(I18nContext);
	return useMemo(() => translator(locale), [locale]);
}
