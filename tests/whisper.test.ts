import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	DICTATION_LANGUAGES, FACTORY_SETTINGS, WHISPER_MODELS, sanitizeUserSettings, whisperLanguage, whisperModelBytes,
	type WhisperModelInfo,
} from "../src/core/index.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { createWhisperModelStore } from "../src/server/whisper-models.ts";
import { isRealGpuAdapter, pcm16ToFloat32 } from "../components/whisper-engine.ts";
import { createDictationLanguageStore } from "../components/dictation-preference.ts";

// ─── core ────────────────────────────────────────────────────────────────

test("the shared language maps onto Whisper: regions collapse, multi detects", () => {
	assert.equal(whisperLanguage("es-419"), "es");
	assert.equal(whisperLanguage("es"), "es");
	assert.equal(whisperLanguage("zh-TW"), "zh");
	assert.equal(whisperLanguage("nl-BE"), "nl");
	assert.equal(whisperLanguage("multi"), "auto");
	// Today every Deepgram language has a Whisper equivalent — none is flagged.
	for (const { code } of DICTATION_LANGUAGES) assert.notEqual(whisperLanguage(code), null, code);
});

test("factory: local Whisper with Turbo (owner, after phase 0)", () => {
	assert.deepEqual(FACTORY_SETTINGS.dictation, { language: "en", engine: "whisper", whisperModel: "large-v3-turbo" });
});

test("the manifest pins every model to one revision with the same seven files", () => {
	for (const m of WHISPER_MODELS) {
		assert.match(m.revision, /^[0-9a-f]{40}$/);
		assert.deepEqual(m.files.map((f) => f.path).sort(), [
			"config.json", "generation_config.json", "onnx/decoder_model_merged_q4.onnx", "onnx/encoder_model_q4.onnx",
			"preprocessor_config.json", "tokenizer.json", "tokenizer_config.json",
		]);
		for (const f of m.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
	}
	// Decimal MB as Settings shows them (139 / 289 / 727 MiB on disk).
	assert.deepEqual(WHISPER_MODELS.map((m) => Math.round(whisperModelBytes(m.id) / 1e6)), [145, 302, 762]);
});

test("settings: engine and model sanitize on read and validate strictly on write", () => {
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { language: "pl", engine: "deepgram", whisperModel: "small" } })?.dictation,
		{ language: "pl", engine: "deepgram", whisperModel: "small" });
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { engine: "siri", whisperModel: "huge" } })?.dictation, {});
	assert.deepEqual(parseDictationSettingsBody({ language: "en", engine: "whisper", whisperModel: "base" }),
		{ ok: true, settings: { language: "en", engine: "whisper", whisperModel: "base" } });
	assert.deepEqual(parseDictationSettingsBody({ engine: "siri" }), { ok: false, error: "Unsupported dictation engine" });
	assert.deepEqual(parseDictationSettingsBody({ whisperModel: "huge" }), { ok: false, error: "Unsupported Whisper model" });
});

// ─── engine helpers ──────────────────────────────────────────────────────

test("pcm16 frames become one float buffer; SwiftShader is not a GPU", () => {
	const out = pcm16ToFloat32([new Int16Array([16384, -32768]), new Int16Array([0]).buffer]);
	assert.deepEqual([...out], [0.5, -1, 0]);
	assert.equal(isRealGpuAdapter({ vendor: "amd", architecture: "rdna-2" }), true);
	assert.equal(isRealGpuAdapter({ vendor: "google", architecture: "swiftshader" }), false);
	assert.equal(isRealGpuAdapter({ vendor: "apple", isFallbackAdapter: true }), false);
	assert.equal(isRealGpuAdapter(null), false);
});

// ─── preference store ────────────────────────────────────────────────────

test("every dictation write sends the whole section (a language change keeps the engine)", async () => {
	const puts: unknown[] = [];
	const store = createDictationLanguageStore(async (_url, init) => {
		if (init?.method === "PUT") {
			const body = JSON.parse(init.body as string);
			puts.push(body);
			return Response.json({ settings: { version: 1, dictation: body } });
		}
		return Response.json({ settings: { version: 1, dictation: { language: "fr", engine: "deepgram" } } });
	});
	await store.load();
	assert.equal(await store.save("pl"), true);
	assert.equal(await store.save({ whisperModel: "base" }), true);
	assert.deepEqual(puts, [
		{ language: "pl", engine: "deepgram", whisperModel: "large-v3-turbo" },
		{ language: "pl", engine: "deepgram", whisperModel: "base" },
	]);
	assert.deepEqual(await store.getSettings(), { language: "pl", engine: "deepgram", whisperModel: "base" });
});

// ─── model store (downloads) ─────────────────────────────────────────────

/** A tiny fake model + a fake Hugging Face that serves it. */
function fakeHub(model: WhisperModelInfo, bodies: Map<string, Buffer>, opts: { hang?: string } = {}) {
	const requested: string[] = [];
	const fetchFn = (async (url: string | URL, init?: RequestInit) => {
		const file = String(url).split(`/resolve/${model.revision}/`)[1]!;
		requested.push(file);
		if (file === opts.hang) {
			return new Response(new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([1]));
					init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
				},
			}));
		}
		return new Response(new Uint8Array(bodies.get(file)!));
	}) as typeof fetch;
	return { fetchFn, requested };
}

function tinyModel(): { info: WhisperModelInfo; bodies: Map<string, Buffer> } {
	const real = WHISPER_MODELS[0]!;
	const bodies = new Map<string, Buffer>();
	const files = real.files.map((f) => {
		const body = Buffer.from(`content of ${f.path}`);
		bodies.set(f.path, body);
		return { path: f.path, size: body.length, sha256: createHash("sha256").update(body).digest("hex") };
	});
	return { info: { ...real, files }, bodies };
}

/** Swap the real manifest entry for the tiny one while `fn` runs. */
async function withManifest(info: WhisperModelInfo, fn: () => Promise<void>) {
	const list = WHISPER_MODELS as WhisperModelInfo[];
	const original = list[0]!;
	list[0] = info;
	try { await fn(); } finally { list[0] = original; }
}

test("a download verifies every file, then the folder appears whole and is servable", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "np-whisper-"));
	const { info, bodies } = tinyModel();
	await withManifest(info, async () => {
		const hub = fakeHub(info, bodies);
		const store = createWhisperModelStore({ root, fetch: hub.fetchFn });
		assert.equal(store.statuses()[0]!.state, "missing");
		store.start("base");
		assert.equal(store.statuses()[0]!.state, "downloading");
		await store.whenSettled("base");
		assert.equal(store.statuses()[0]!.state, "ready");
		assert.equal(hub.requested.length, 7);
		assert.ok(fs.existsSync(path.join(root, "whisper-base", "onnx", "encoder_model_q4.onnx")));
		assert.ok(!fs.existsSync(path.join(root, "whisper-base.part")));
		// Serving: manifest files only, nothing else.
		assert.ok(store.file("whisper-base", "tokenizer.json"));
		assert.equal(store.file("whisper-base", "../../settings.json"), null);
		assert.equal(store.file("whisper-base", "onnx/encoder_model.onnx"), null);
		assert.equal(store.file("whisper-small", "tokenizer.json"), null, "not downloaded");
		assert.equal(store.file("..", "tokenizer.json"), null);
		// Delete removes it.
		await store.cancelOrDelete("base");
		assert.equal(store.statuses()[0]!.state, "missing");
		assert.ok(!fs.existsSync(path.join(root, "whisper-base")));
	});
});

test("a corrupted file fails verification and leaves nothing behind", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "np-whisper-"));
	const { info, bodies } = tinyModel();
	bodies.set("tokenizer.json", Buffer.from("tampered!!".padEnd(bodies.get("tokenizer.json")!.length, "!")));
	await withManifest(info, async () => {
		const store = createWhisperModelStore({ root, fetch: fakeHub(info, bodies).fetchFn });
		const warn = console.warn;
		console.warn = () => {};
		try {
			store.start("base");
			await store.whenSettled("base");
		} finally { console.warn = warn; }
		const status = store.statuses()[0]!;
		assert.equal(status.state, "error");
		assert.match(status.error!, /Verification failed for tokenizer.json/);
		assert.deepEqual(fs.readdirSync(root), []);
	});
});

test("cancel aborts a download in flight and removes the partial files", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "np-whisper-"));
	const { info, bodies } = tinyModel();
	await withManifest(info, async () => {
		const store = createWhisperModelStore({ root, fetch: fakeHub(info, bodies, { hang: "onnx/encoder_model_q4.onnx" }).fetchFn });
		store.start("base");
		while (!fs.existsSync(path.join(root, "whisper-base.part", "onnx"))) await new Promise((r) => setTimeout(r, 5));
		await store.cancelOrDelete("base");
		const status = store.statuses()[0]!;
		assert.equal(status.state, "missing", "a cancel is not an error");
		assert.deepEqual(fs.readdirSync(root), []);
	});
});
