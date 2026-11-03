import assert from "node:assert/strict";
import { it } from "node:test";
import { getStoredItem } from "../src/core/stored-item.ts";

function memoryStorage(initial: Record<string, string>): Storage {
	const map = new Map(Object.entries(initial));
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (key) => map.get(key) ?? null,
		key: (index) => [...map.keys()][index] ?? null,
		removeItem: (key) => void map.delete(key),
		setItem: (key, value) => void map.set(key, String(value)),
	};
}

it("reads np keys, falling back to the pre-rename lh twin once", () => {
	const storage = memoryStorage({ "lh:sidebar-open": "0", "np:keymap": "{}", "lh:keymap": "old" });
	assert.equal(getStoredItem(storage, "np:keymap"), "{}");
	assert.equal(getStoredItem(storage, "np:sidebar-open"), "0");
	assert.equal(storage.getItem("np:sidebar-open"), "0");
	assert.equal(getStoredItem(storage, "np.graph.camera.v1"), null);
	assert.equal(getStoredItem(storage, "other"), null);
});
