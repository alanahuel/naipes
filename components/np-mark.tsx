/**
 * NpMark — the Naipes mark (2026-11-03): the app icon's card-graph without
 * the squircle or corner indices, inlined as JSX so it rides along with the
 * components (no network fetch, crisp at any size). 620×820 viewBox (the tilted card plus margin),
 * no padding: sizing/padding is the consumer's job. The cream card reads on
 * the dark sidebar band; the full icon lives in build/icon-flat.svg.
 */
export function NpMark({ className = "" }: { className?: string }) {
	return (
		<svg viewBox="0 0 620 820" className={className} aria-hidden="true">
			<g transform="rotate(-7 310 410)">
				<rect x="60" y="40" width="500" height="740" rx="54" fill="#f7f1e3" />
				<g stroke="#1c1a18" strokeWidth="24" strokeLinecap="round">
					<line x1="256" y1="270" x2="426" y2="376" />
					<line x1="256" y1="270" x2="202" y2="458" />
					<line x1="202" y1="458" x2="426" y2="376" />
					<line x1="426" y1="376" x2="380" y2="570" />
					<line x1="202" y1="458" x2="380" y2="570" />
				</g>
				<circle cx="256" cy="270" r="58" fill="#c8102e" />
				<circle cx="426" cy="376" r="64" fill="#1c1a18" />
				<circle cx="202" cy="458" r="52" fill="#1c1a18" />
				<circle cx="380" cy="570" r="54" fill="#c8102e" />
			</g>
		</svg>
	);
}
