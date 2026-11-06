"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/components/i18n";
import { useServerEvent } from "@/components/server-events";
import { BrailleSpinner } from "@/components/braille-spinner";
import type { AttachmentTray } from "@/components/attachments";
import { MAX_ATTACHMENTS, PHONE_PORT, type PhoneNetwork, type PhoneSessionInfo } from "@/src/core";

/**
 * «ENVIAR DESDE EL MÓVIL», the desktop half (owner, 2026-11-06 — image
 * attachments phase 2): the session-scoped QR panel (the lightbox's
 * geometry). Opening it starts a token on the server (and the phone port);
 * photos sent from the phone arrive on the event bus and join the tray
 * that opened it. Closing it — Cerrar, Esc, unmount — closes the token.
 */

type PanelState =
	| { kind: "loading" }
	| { kind: "error"; code: "no_network" | "port_busy" | "failed" | "full" }
	| { kind: "ready"; info: PhoneSessionInfo };

/** mm:ss for the countdown (pure — the tests pin it). */
export function countdown(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function PhoneOverlay({ chatId, tray, onClose }: { chatId: string; tray: AttachmentTray; onClose: () => void }) {
	const t = useT();
	const [state, setState] = useState<PanelState>({ kind: "loading" });
	const [network, setNetwork] = useState<PhoneNetwork>("wifi");
	const [received, setReceived] = useState(0);
	const [now, setNow] = useState(() => Date.now());
	const tokenRef = useRef<string | null>(null);
	const trayRef = useRef(tray);
	trayRef.current = tray;

	const closeToken = useCallback(() => {
		const token = tokenRef.current;
		tokenRef.current = null;
		if (token) {
			void fetch(`/api/chats/${encodeURIComponent(chatId)}/phone?token=${encodeURIComponent(token)}`, { method: "DELETE", keepalive: true }).catch(() => {});
		}
	}, [chatId]);

	const start = useCallback(async () => {
		closeToken();
		setState({ kind: "loading" });
		setReceived(0);
		const capacity = MAX_ATTACHMENTS - trayRef.current.liveCount();
		if (capacity < 1) {
			setState({ kind: "error", code: "full" });
			return;
		}
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/phone`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ trayId: trayRef.current.trayId, capacity }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { code?: string };
				setState({ kind: "error", code: body.code === "no_network" || body.code === "port_busy" ? body.code : "failed" });
				return;
			}
			const info = (await res.json()) as PhoneSessionInfo;
			tokenRef.current = info.token;
			setNetwork(info.links.some((l) => l.network === "wifi") ? "wifi" : info.links[0]!.network);
			setNow(Date.now());
			setState({ kind: "ready", info });
		} catch {
			setState({ kind: "error", code: "failed" });
		}
	}, [chatId, closeToken]);

	useEffect(() => {
		void start();
		return closeToken;
	}, [start, closeToken]);

	// The countdown tick.
	useEffect(() => {
		if (state.kind !== "ready") return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [state.kind]);

	// Photos from the phone → the tray that opened this panel.
	useServerEvent("phone-attachments", (event) => {
		if (event.chatId !== chatId || event.token !== tokenRef.current) return;
		trayRef.current.addRefs(event.refs);
		setReceived((n) => n + event.refs.length);
	});

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const expired = state.kind === "ready" && now >= state.info.expiresAt;
	// Full = this code's capacity is spent (the tray snapshot may be stale).
	const full = state.kind === "ready" && received >= state.info.capacity;
	const link = state.kind === "ready" ? (state.info.links.find((l) => l.network === network) ?? state.info.links[0]) : undefined;

	return (
		<div data-testid="phone-overlay" className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={onClose}>
			<div
				role="dialog"
				aria-label={t("session.phone.title")}
				onClick={(e) => e.stopPropagation()}
				className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-lg"
			>
				<div className="flex items-center justify-between">
					<h2 className="text-base font-semibold">{t("session.phone.title")}</h2>
					<button
						type="button"
						aria-label={t("session.phone.close")}
						onClick={onClose}
						className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-4" />
					</button>
				</div>

				{state.kind === "loading" && (
					<div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
						<BrailleSpinner /> {t("session.phone.loading")}
					</div>
				)}

				{state.kind === "error" && (
					<p role="alert" className="py-6 text-sm text-warn">
						{state.code === "no_network"
							? t("session.phone.noNetwork")
							: state.code === "port_busy"
								? t("session.phone.portBusy", { port: PHONE_PORT })
								: state.code === "full"
									? t("session.phone.full")
									: t("session.phone.failed")}
					</p>
				)}

				{state.kind === "ready" && link && (
					<>
						<p className="text-sm text-muted-foreground">{t("session.phone.scan")}</p>
						<div className={cn("relative mx-auto w-full max-w-64 rounded-xl bg-white p-3", expired && "opacity-20")}>
							<div
								data-testid="phone-qr"
								className="[&>svg]:h-auto [&>svg]:w-full"
								// The SVG comes from our own route (qrcode, never user input).
								dangerouslySetInnerHTML={{ __html: link.svg }}
							/>
						</div>
						{state.info.links.length > 1 && (
							<div role="radiogroup" className="mx-auto flex rounded-lg border border-border p-0.5 font-ui text-xs">
								{state.info.links.map((l) => (
									<button
										key={l.network}
										type="button"
										role="radio"
										aria-checked={l.network === link.network}
										onClick={() => setNetwork(l.network)}
										className={cn(
											"rounded-md px-3 py-1",
											l.network === link.network ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
										)}
									>
										{l.network === "wifi" ? t("session.phone.wifi") : t("session.phone.tailscale")}
									</button>
								))}
							</div>
						)}
						<p className="break-all text-center font-ui text-[11px] text-muted-foreground">{link.url.replace(/\/m\/.*/, "/m/…")}</p>
						<div className="flex items-center justify-between gap-2 font-ui text-xs">
							<span className={cn(expired ? "text-warn" : "text-muted-foreground")}>
								{expired ? t("session.phone.expired") : t("session.phone.expires", { time: countdown(state.info.expiresAt - now) })}
							</span>
							<span data-testid="phone-received" className={cn(received > 0 ? "text-ok" : "text-muted-foreground")}>
								{t("session.phone.received", { n: received })}
							</span>
						</div>
						{full && !expired && <p className="font-ui text-xs text-muted-foreground">{t("session.phone.full")}</p>}
						{expired && (
							<button
								type="button"
								onClick={() => void start()}
								className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent"
							>
								{t("session.phone.again")}
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}
