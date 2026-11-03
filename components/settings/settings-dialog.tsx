"use client";
/**
 * SETTINGS NAVIGATION (Naipes interface, stage 3 — 2026-11-03). The
 * settings DIALOG is gone: settings are pages (components/settings/
 * settings-page.tsx) opened from the profile menu. This module keeps the
 * old seam's name so every caller still works — `open(section?, row?)`
 * (the setup flow, the dictation error, mod+, and the Electron menu's
 * "Settings…") now NAVIGATES to the page that holds that section, with an
 * optional Keys row to unfold (?row=…).
 *
 * It also still mounts the ChatGPT + subscription UI providers at the
 * app root (their connect flows outlive any single page).
 */

import { createContext, useCallback, useContext, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChatGPTUIProvider } from "./chatgpt-connection.tsx";
import { NativeSubscriptionUIProvider } from "./subscription-connections.tsx";
import { pageForSection } from "./pages.ts";

/** The URL a section (+ optional Keys row) opens. Pure — tested. */
export function settingsHref(section?: string, row?: string): string {
	const page = pageForSection(section, row);
	return row ? `/settings/${page}?row=${encodeURIComponent(row)}` : `/settings/${page}`;
}

const DialogContext = createContext<{ open: (section?: string, row?: string) => void }>({ open: () => {} });

export function SettingsDialogProvider({ children }: { children: React.ReactNode }) {
	const router = useRouter();
	const open = useCallback((section?: string, row?: string) => router.push(settingsHref(section, row)), [router]);
	useEffect(() => window.np?.onOpenSettings?.((section) => open(section)), [open]);
	return (
		<ChatGPTUIProvider>
			<NativeSubscriptionUIProvider>
				<DialogContext.Provider value={{ open }}>{children}</DialogContext.Provider>
			</NativeSubscriptionUIProvider>
		</ChatGPTUIProvider>
	);
}

/** `open(section?, row?)` — navigate to the settings page for a section. */
export function useSettingsDialog() {
	return useContext(DialogContext);
}
