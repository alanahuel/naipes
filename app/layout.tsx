import type { Metadata } from "next";
import { Geist, JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { THEME_BOOT_SCRIPT } from "@/src/core";
import UpdateBanner from "@/components/update-banner";

// Interface = Geist, teaching prose = Source Sans 3, code = JetBrains Mono,
// session titles = CMU Serif (the bundled np-cmu @font-face in globals.css —
// no CDN; optional in Appearance).
const ui = Geist({ subsets: ["latin"], variable: "--font-geist" });
const code = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Naipes",
	description: "Un tutor con agentes de IA que aprende cómo piensas: lecciones, práctica y un grafo de lo que sabes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		// The `dark` class is NOT server-rendered: the theme depends on the
		// cached mode + the OS, so THEME_BOOT_SCRIPT sets it before paint
		// (hence suppressHydrationWarning on <html>).
		<html lang="es" className={`${ui.variable} ${code.variable} ${prose.variable}`} suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
			</head>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</body>
		</html>
	);
}
