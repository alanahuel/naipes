/**
 * «ENVIAR DESDE EL MÓVIL» (owner, 2026-11-06 — image attachments phase 2):
 * a QR on the desktop opens a one-use page on the learner's phone; the
 * photos taken there land in the SAME attachment tray whose phone button
 * opened the QR. Owner decisions:
 *
 * - Wi-Fi and Tailscale; the QR carries the Wi-Fi address by default with
 *   a Wi-Fi/Tailscale switch.
 * - A FIXED port (PHONE_PORT) the learner opens in their firewall once;
 *   it listens ONLY while a QR is active (src/server/phone.ts).
 * - A 256-bit token per QR, valid PHONE_SESSION_MS or until the QR
 *   closes, for several batches while the tray has room.
 * - Off by default (settings.phone.enabled).
 *
 * Pure: constants and the address choice the route and tests share.
 */

/** The phone listener's fixed port (owner, 2026-11-06). */
export const PHONE_PORT = 47800;

/** A QR's lifetime (owner, 2026-11-06: 10 minutes). */
export const PHONE_SESSION_MS = 10 * 60_000;

/** Which network an address belongs to. */
export type PhoneNetwork = "wifi" | "tailscale";

/** One QR target: the network and the phone-page URL. */
export interface PhoneLink {
	network: PhoneNetwork;
	url: string;
	/** The QR as an SVG string (server-rendered). */
	svg: string;
}

/** What POST /api/chats/[id]/phone answers. */
export interface PhoneSessionInfo {
	token: string;
	/** Epoch ms. */
	expiresAt: number;
	/** Photos the phone may still send (4 − the tray's images at open). */
	capacity: number;
	links: PhoneLink[];
}

/** The node os.networkInterfaces() shape, narrowed to what we read. */
export type InterfaceMap = Record<string, readonly { address: string; family: string | number; internal: boolean }[] | undefined>;

function ipv4(address: string): number[] | null {
	const parts = address.split(".").map(Number);
	return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

/** Tailscale's CGNAT range, 100.64.0.0/10. */
function isTailscaleIp(p: number[]): boolean {
	return p[0] === 100 && p[1]! >= 64 && p[1]! <= 127;
}

function isPrivateLan(p: number[]): boolean {
	return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168);
}

/** Virtual bridges never reach a phone (docker, libvirt, veth pairs). */
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|lo)/;

/** The Wi-Fi/LAN and Tailscale IPv4 addresses, first match each (pure). */
export function phoneAddresses(interfaces: InterfaceMap): Partial<Record<PhoneNetwork, string>> {
	const out: Partial<Record<PhoneNetwork, string>> = {};
	for (const [name, entries] of Object.entries(interfaces)) {
		for (const entry of entries ?? []) {
			if (entry.internal || (entry.family !== "IPv4" && entry.family !== 4)) continue;
			const p = ipv4(entry.address);
			if (!p) continue;
			if (name.startsWith("tailscale") || isTailscaleIp(p)) out.tailscale ??= entry.address;
			else if (!VIRTUAL_IFACE.test(name) && isPrivateLan(p)) out.wifi ??= entry.address;
		}
	}
	return out;
}

/** The phone page's URL for an address and token. */
export function phoneUrl(address: string, token: string, port = PHONE_PORT): string {
	return `http://${address}:${port}/m/${token}`;
}
