"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { PaperclipIcon, SmartphoneIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/components/i18n";
import { BrailleSpinner } from "@/components/braille-spinner";
import {
	ATTACHMENT_ACCEPT,
	ATTACHMENT_JPEG_QUALITY,
	ATTACHMENT_MAX_SIDE,
	MAX_ATTACHMENTS,
	type AttachmentRef,
} from "@/src/core";

/**
 * IMAGE ATTACHMENTS, client side (owner, 2026-11-06 — phase 1): the tray
 * every learner input shares (composer, practice dock, text answers) —
 * clip button, paste and drag-and-drop; at most four images; each one
 * re-encoded here (JPEG, longest side ≤ 2000 px) and uploaded at once, so
 * the send only names ids. History rows render thumbnails; a click opens
 * the session-scoped lightbox.
 */

/** The chat page's attachment scope: which chat uploads land in, whether
 *  the session's model can see images, and the lightbox opener. Null
 *  outside a chat page — the tray then renders nothing. */
export const AttachmentsContext = createContext<{
	chatId: string;
	vision: boolean;
	openImage: (src: string) => void;
	/** «Enviar desde el móvil» is on (settings.phone.enabled, phase 2). */
	phone?: boolean;
	/** Open the phone QR for this tray (the chat page mounts the overlay). */
	openPhone?: (tray: AttachmentTray) => void;
} | null>(null);

export function attachmentUrl(chatId: string, id: string): string {
	return `/api/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(id)}`;
}

/** Why a file was refused before upload. */
export type AttachmentRefusal = "heic" | "unsupported" | "tooMany" | "failed" | "noVision";

/** Classify a picked/pasted/dropped file (pure — the tests pin it). */
export function attachmentKind(file: { type: string; name: string }): "ok" | "heic" | "unsupported" {
	const type = file.type.toLowerCase();
	if (/\.(heic|heif)$/i.test(file.name) || type === "image/heic" || type === "image/heif") return "heic";
	return (ATTACHMENT_ACCEPT as readonly string[]).includes(type) ? "ok" : "unsupported";
}

/** The re-encode target size (pure): longest side ≤ ATTACHMENT_MAX_SIDE,
 *  never upscaled. */
export function fitWithin(width: number, height: number, max = ATTACHMENT_MAX_SIDE): { width: number; height: number } {
	const scale = Math.min(1, max / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Decode → resize → JPEG (the owner's 2000 px / ~85 rule). PNG
 *  transparency lands on white, the paper the photos were taken of. */
async function prepareImage(file: Blob): Promise<Blob> {
	const bitmap = await createImageBitmap(file);
	try {
		const { width, height } = fitWithin(bitmap.width, bitmap.height);
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, width, height);
		ctx.drawImage(bitmap, 0, 0, width, height);
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))), "image/jpeg", ATTACHMENT_JPEG_QUALITY),
		);
	} finally {
		bitmap.close();
	}
}

/** Local previews are object URLs; phone arrivals use the server route. */
function revokePreview(url: string): void {
	if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

export interface TrayItem {
	key: string;
	/** Local preview (object URL) — shown while uploading and after. */
	preview: string;
	/** The server ref once uploaded. */
	ref?: AttachmentRef;
}

/** One input's pending images. `refs` are the uploaded ones in order;
 *  `uploading` blocks the send until every image has landed. */
export function useAttachmentTray(
	scopeOverride?: { chatId: string; vision: boolean; phone?: boolean; openPhone?: (tray: AttachmentTray) => void } | null,
) : AttachmentTray {
	// The chat page owns the provider AND the composer's tray, so it hands
	// its scope in directly; the docks (inside the provider) read context.
	const context = useContext(AttachmentsContext);
	const scope = scopeOverride ?? context;
	const [items, setItems] = useState<TrayItem[]>([]);
	const [refusal, setRefusal] = useState<AttachmentRefusal | null>(null);
	const itemsRef = useRef<TrayItem[]>([]);
	// The phone QR addresses THIS tray (phase 2): a stable per-mount id.
	const [trayId] = useState(() => `tray_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`);
	const commit = (next: TrayItem[]) => {
		itemsRef.current = next;
		setItems(next);
	};
	useEffect(() => () => itemsRef.current.forEach((i) => revokePreview(i.preview)), []);

	const enabled = scope !== null && scope.vision;

	const add = useCallback(
		async (files: readonly File[]) => {
			if (!scope || !scope.vision || files.length === 0) return;
			setRefusal(null);
			for (const file of files) {
				const kind = attachmentKind(file);
				if (kind !== "ok") {
					setRefusal(kind);
					continue;
				}
				if (itemsRef.current.length >= MAX_ATTACHMENTS) {
					setRefusal("tooMany");
					break;
				}
				const key = `tray_${crypto.randomUUID()}`;
				let jpeg: Blob;
				try {
					jpeg = await prepareImage(file);
				} catch {
					setRefusal("failed");
					continue;
				}
				const preview = URL.createObjectURL(jpeg);
				commit([...itemsRef.current, { key, preview }]);
				try {
					const res = await fetch(`/api/chats/${encodeURIComponent(scope.chatId)}/attachments`, {
						method: "POST",
						headers: { "Content-Type": "image/jpeg" },
						body: jpeg,
					});
					if (!res.ok) throw new Error(String(res.status));
					const { attachment } = (await res.json()) as { attachment: AttachmentRef };
					if (!itemsRef.current.some((i) => i.key === key)) {
						// Removed while uploading: drop the orphan server-side too.
						void fetch(attachmentUrl(scope.chatId, attachment.id), { method: "DELETE" });
						continue;
					}
					commit(itemsRef.current.map((i) => (i.key === key ? { ...i, ref: attachment } : i)));
				} catch {
					URL.revokeObjectURL(preview);
					commit(itemsRef.current.filter((i) => i.key !== key));
					setRefusal("failed");
				}
			}
		},
		[scope],
	);

	const remove = useCallback(
		(key: string) => {
			const item = itemsRef.current.find((i) => i.key === key);
			if (!item) return;
			revokePreview(item.preview);
			commit(itemsRef.current.filter((i) => i.key !== key));
			setRefusal(null);
			if (item.ref && scope) void fetch(attachmentUrl(scope.chatId, item.ref.id), { method: "DELETE" });
		},
		[scope],
	);

	/** Hand the uploaded refs to a send and empty the tray (the files now
	 *  belong to the message — nothing is deleted). */
	const take = useCallback((): AttachmentRef[] => {
		const refs = itemsRef.current.flatMap((i) => (i.ref ? [i.ref] : []));
		itemsRef.current.forEach((i) => revokePreview(i.preview));
		commit([]);
		setRefusal(null);
		return refs;
	}, []);

	/** Paste handler for a textarea: image files are claimed, text pastes
	 *  pass through untouched. */
	const onPaste = useCallback(
		(e: React.ClipboardEvent) => {
			const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/") || attachmentKind(f) === "heic");
			if (files.length === 0 || !scope) return;
			e.preventDefault();
			if (!scope.vision) {
				setRefusal("noVision");
				return;
			}
			void add(files);
		},
		[add, scope],
	);

	/** Drop-zone handlers for the input's shell. */
	const dropProps = {
		onDragOver: (e: React.DragEvent) => {
			if (scope && e.dataTransfer.types.includes("Files")) e.preventDefault();
		},
		onDrop: (e: React.DragEvent) => {
			if (!e.dataTransfer.files.length) return;
			e.preventDefault();
			if (enabled) void add([...e.dataTransfer.files]);
			else if (scope) setRefusal("noVision");
		},
	};

	/** Photos that arrived from the phone (already on the server): they
	 *  join the tray as ready items, previewed from the attachment route. */
	const addRefs = useCallback(
		(refs: readonly AttachmentRef[]) => {
			if (!scope || refs.length === 0) return;
			const known = new Set(itemsRef.current.flatMap((i) => (i.ref ? [i.ref.id] : [])));
			const fresh = refs.filter((r) => !known.has(r.id)).slice(0, Math.max(0, MAX_ATTACHMENTS - itemsRef.current.length));
			if (fresh.length === 0) return;
			setRefusal(null);
			commit([
				...itemsRef.current,
				...fresh.map((ref) => ({ key: `tray_${ref.id}`, preview: attachmentUrl(scope.chatId, ref.id), ref })),
			]);
		},
		[scope],
	);

	const uploading = items.some((i) => !i.ref);
	const tray: AttachmentTray = {
		available: scope !== null,
		enabled,
		items,
		refusal,
		uploading,
		/** Uploaded images ready to send. */
		count: items.filter((i) => i.ref).length,
		full: items.length >= MAX_ATTACHMENTS,
		add,
		addRefs,
		remove,
		take,
		onPaste,
		dropProps,
		trayId,
		liveCount: () => itemsRef.current.length,
		/** The phone button shows (setting on, inside a chat page). */
		phoneAvailable: scope !== null && scope.phone === true && typeof scope.openPhone === "function",
		openPhone: () => scope?.openPhone?.(tray),
	};
	return tray;
}

/** One input's tray, as useAttachmentTray returns it. */
export interface AttachmentTray {
	available: boolean;
	enabled: boolean;
	items: TrayItem[];
	refusal: AttachmentRefusal | null;
	uploading: boolean;
	count: number;
	full: boolean;
	add: (files: readonly File[]) => Promise<void>;
	addRefs: (refs: readonly AttachmentRef[]) => void;
	remove: (key: string) => void;
	take: () => AttachmentRef[];
	onPaste: (e: React.ClipboardEvent) => void;
	dropProps: { onDragOver: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void };
	trayId: string;
	/** The tray's CURRENT size (read through the ref — never stale). */
	liveCount: () => number;
	phoneAvailable: boolean;
	openPhone: () => void;
}

/** The clip button: opens the file picker; disabled (with the reason as
 *  its tooltip) when the session's model has no vision. */
export function AttachButton({ tray, className }: { tray: AttachmentTray; className?: string }) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	if (!tray.available) return null;
	const label = tray.enabled ? t("session.attach.add") : t("session.attach.noVision");
	return (
		<>
			<button
				type="button"
				data-testid="attach-button"
				aria-label={label}
				title={label}
				disabled={!tray.enabled || tray.full}
				onClick={() => inputRef.current?.click()}
				className={cn(
					"flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
					className,
				)}
			>
				<PaperclipIcon className="size-4" />
			</button>
			{tray.phoneAvailable && (
				<button
					type="button"
					data-testid="phone-button"
					aria-label={tray.enabled ? t("session.phone.open") : t("session.attach.noVision")}
					title={tray.enabled ? t("session.phone.open") : t("session.attach.noVision")}
					disabled={!tray.enabled || tray.full}
					onClick={() => tray.openPhone()}
					className={cn(
						"flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
						className,
					)}
				>
					<SmartphoneIcon className="size-4" />
				</button>
			)}
			<input
				ref={inputRef}
				type="file"
				accept={[...ATTACHMENT_ACCEPT, ".heic", ".heif"].join(",")}
				multiple
				hidden
				onChange={(e) => {
					const files = [...(e.target.files ?? [])];
					e.target.value = "";
					void tray.add(files);
				}}
			/>
		</>
	);
}

/** The pending thumbnails (× removes) + the counter and any refusal line.
 *  Renders nothing when the tray is empty and nothing was refused. */
export function AttachmentTrayView({ tray }: { tray: AttachmentTray }) {
	const t = useT();
	if (tray.items.length === 0 && !tray.refusal) return null;
	return (
		<div data-testid="attachment-tray" className="flex flex-col gap-1.5 px-2 pt-2">
			{tray.items.length > 0 && (
				<div className="flex flex-wrap items-end gap-2">
					{tray.items.map((item) => (
						<div key={item.key} className="relative size-16 overflow-hidden rounded-md border border-border bg-muted">
							{/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
							<img src={item.preview} alt="" className={cn("size-full object-cover", !item.ref && "opacity-50")} />
							{!item.ref && (
								<span className="absolute inset-0 flex items-center justify-center" aria-label={t("session.attach.uploading")}>
									<BrailleSpinner />
								</span>
							)}
							<button
								type="button"
								aria-label={t("session.attach.remove")}
								onClick={() => tray.remove(item.key)}
								className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm hover:bg-accent"
							>
								<XIcon className="size-3" />
							</button>
						</div>
					))}
					<span className="pb-0.5 font-ui text-xs tabular-nums text-muted-foreground">
						{t("session.attach.count", { n: tray.items.length, max: MAX_ATTACHMENTS })}
					</span>
				</div>
			)}
			{tray.refusal && (
				<div role="status" className="font-ui text-xs text-warn">
					{tray.refusal === "tooMany"
						? t("session.attach.tooMany", { max: MAX_ATTACHMENTS })
						: tray.refusal === "heic"
							? t("session.attach.heic")
							: tray.refusal === "unsupported"
								? t("session.attach.unsupported")
								: tray.refusal === "noVision"
									? t("session.attach.noVision")
									: t("session.attach.failed")}
				</div>
			)}
		</div>
	);
}

/** A sent message's images: thumbnails; a click opens the lightbox. */
export function AttachmentThumbs({ refs, className }: { refs: readonly AttachmentRef[] | undefined; className?: string }) {
	const t = useT();
	const scope = useContext(AttachmentsContext);
	if (!scope || !refs || refs.length === 0) return null;
	return (
		<div data-testid="attachment-thumbs" className={cn("mt-1.5 flex flex-wrap gap-2", className)}>
			{refs.map((ref) => {
				const src = attachmentUrl(scope.chatId, ref.id);
				return (
					<button
						key={ref.id}
						type="button"
						aria-label={t("session.attach.open")}
						onClick={() => scope.openImage(src)}
						className="overflow-hidden rounded-md border border-border bg-muted transition-opacity hover:opacity-90"
					>
						{/* eslint-disable-next-line @next/next/no-img-element -- served by the local API */}
						<img src={src} alt="" width={ref.width} height={ref.height} loading="lazy" className="h-24 w-auto max-w-48 object-cover" />
					</button>
				);
			})}
		</div>
	);
}

/** The session-scoped image focus (the MermaidOverlay's geometry: absolute
 *  inside the session area, below the drag bar). Esc or the × closes —
 *  claimed at the document level (the one-Esc law). */
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
	const t = useT();
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
	return (
		<div
			data-testid="image-lightbox"
			className="absolute inset-0 z-40 flex flex-col bg-background/80 p-4 backdrop-blur-sm"
			onClick={onClose}
		>
			<div className="flex justify-end">
				<button
					type="button"
					aria-label={t("session.attach.close")}
					onClick={onClose}
					className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</div>
			<div className="flex min-h-0 flex-1 items-center justify-center">
				{/* eslint-disable-next-line @next/next/no-img-element -- served by the local API */}
				<img src={src} alt="" onClick={(e) => e.stopPropagation()} className="max-h-full max-w-full rounded-md object-contain shadow-lg" />
			</div>
		</div>
	);
}
