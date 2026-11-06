"use client";
/** The interface-language row: writes general.language and switches the
 *  live locale at once (no reload). */
import { LOCALES, LOCALE_NAMES, isLocale, type Locale } from "@/src/core";
import { useLocale, useT } from "@/components/i18n";
import { SettingsRow, ThinSelect } from "./controls.tsx";

export function LanguageSetting({ onLanguageChange }: { onLanguageChange: (locale: Locale) => Promise<unknown> | void }) {
	const t = useT();
	const { locale, setLocale } = useLocale();
	return (
		<SettingsRow label={t("common.language")} hint={t("common.languageHint")} testid="row-language">
			<ThinSelect
				value={locale}
				ariaLabel={t("common.language")}
				testid="select-language"
				onChange={(value) => {
					if (!isLocale(value)) return;
					setLocale(value);
					void onLanguageChange(value);
				}}
				options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
			/>
		</SettingsRow>
	);
}
