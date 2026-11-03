/**
 * localStorage reads that survive the LearnHarness → Naipes rename
 * (2026-11-03): keys moved from the "lh" prefix to "np". A missing "np…"
 * key falls back to its "lh…" twin once and copies the value forward, so
 * UI preferences (sidebar, filters, keymap, graph camera) carry over.
 */
export function getStoredItem(storage: Storage, key: string): string | null {
	const value = storage.getItem(key);
	if (value !== null || !key.startsWith("np")) return value;
	const legacy = storage.getItem(`lh${key.slice(2)}`);
	if (legacy !== null) {
		try {
			storage.setItem(key, legacy);
		} catch {
			// Quota/privacy errors: the value is still returned for this read.
		}
	}
	return legacy;
}
