import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, WHISPER_MODEL_MISSING, dictationErrorLabel, type Dictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { useDictationLanguage } from "../components/dictation-preference.ts";
import type { DictationLanguage, UserSettings } from "../src/core/index.ts";
import type { WhisperRequest } from "../components/whisper-worker.ts";

/** The engine's Web Worker, faked: records requests; `reply` answers them.
 *  The engine keeps ONE app-lifetime worker, so the handler is static. */
class FakeWorker {
	static requests: WhisperRequest[] = [];
	static reply: (req: WhisperRequest) => Promise<{ ok: true; text?: string } | { ok: false; error: string }> | null =
		async () => ({ ok: true });
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: { message: string }) => void) | null = null;
	constructor(readonly url: URL, readonly options: unknown) {
		queueMicrotask(() => this.onmessage?.({ data: { ready: true } }));
	}
	postMessage(req: WhisperRequest) {
		FakeWorker.requests.push(req);
		const answer = FakeWorker.reply(req);
		void answer?.then((res) => this.onmessage?.({ data: { id: req.id, ...res } }));
	}
	terminate() {}
}

class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static last: Worklet | null = null;
	port: { onmessage?: (event: { data: unknown }) => void } = {};
	constructor() { Worklet.last = this; }
	connect() {}
	disconnect() {}
}

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function fixture(opts: { language?: DictationLanguage; ready?: boolean } = {}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		record: { version: 1, dictation: { language: opts.language ?? "es-419" } } as UserSettings,
		ready: opts.ready ?? true,
		captures: 0,
		tokenFetches: 0,
		appends: [] as string[],
	};
	FakeWorker.requests = [];
	FakeWorker.reply = async () => ({ ok: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			state.captures++;
			return { getTracks: () => [{ stop() {} }] };
		} } },
		WebSocket: class { constructor() { throw new Error("Whisper runs must not open a socket"); } },
		AudioContext: AudioGraph, AudioWorkletNode: Worklet, Worker: FakeWorker,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			if (url === "/api/stt/token") { state.tokenFetches++; return Response.json({ token: "t" }); }
			if (url === "/api/settings") return Response.json({ settings: state.record });
			if (url === "/api/stt/whisper") {
				return Response.json({ models: [{ id: "large-v3-turbo", label: "Large-v3-turbo", bytes: 1, state: state.ready ? "ready" : "missing" }] });
			}
			throw new Error(`unexpected fetch ${url}`);
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	let setting!: ReturnType<typeof useDictationLanguage>;
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		setting = useDictationLanguage();
		return null;
	}
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	// A fresh server record per fixture (the preference cache is window-lifetime).
	if (setting.language !== undefined) await act(async () => { notifySettingsSaved("dictation"); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return { state, get dictation() { return latest; } };
}

/** Two 2048-sample linear16 frames, as the capture worklet posts them. */
async function speak() {
	await act(async () => {
		for (let i = 0; i < 2; i++) Worklet.last!.port.onmessage!({ data: { type: "audio", buffer: new Int16Array(2048).fill(16384) } });
	});
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("Whisper (the default engine) records without a socket and transcribes the whole run at stop", async () => {
	const f = await fixture({ language: "es-419" });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.state.tokenFetches, 0, "no Deepgram token for Whisper runs");
	const load = FakeWorker.requests.find((r) => r.type === "load");
	assert.deepEqual(load?.model, { dir: "whisper-large-v3-turbo", dtype: { encoder_model: "q4", decoder_model_merged: "q4" } }, "Turbo is the factory model");
	assert.equal(load?.device, "wasm", "no WebGPU in the fixture → WASM");

	const reply = Promise.withResolvers<{ ok: true; text: string }>();
	FakeWorker.reply = (req) => (req.type === "transcribe" ? reply.promise : Promise.resolve({ ok: true }));
	await speak();
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping", "the spinner shows while Whisper transcribes");
	const job = FakeWorker.requests.find((r) => r.type === "transcribe");
	assert(job && job.type === "transcribe");
	assert.equal(job.language, "es", "es-419 collapses to Whisper's es");
	assert.equal(job.audio.length, 4096);
	assert.equal(job.audio[0], 0.5);

	await act(async () => { reply.resolve({ ok: true, text: "hola mundo" }); });
	assert.equal(f.dictation.phase, "idle");
	assert.deepEqual(f.state.appends, ["hola mundo"]);
});

test("multilingual dictation lets Whisper detect the language", async () => {
	const f = await fixture({ language: "multi" });
	FakeWorker.reply = async (req) => (req.type === "transcribe" ? { ok: true, text: "x" } : { ok: true });
	await act(async () => { f.dictation.toggle(); });
	await speak();
	await act(async () => { f.dictation.stop(); });
	const job = FakeWorker.requests.find((r) => r.type === "transcribe");
	assert(job && job.type === "transcribe");
	assert.equal(job.language, null);
});

test("a missing model fails before the microphone opens, with the Settings line", async () => {
	const f = await fixture({ ready: false });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, WHISPER_MODEL_MISSING);
	assert.equal(f.state.captures, 0);
	assert.equal(dictationErrorLabel(WHISPER_MODEL_MISSING), "Download a Whisper model in Settings to dictate");
});

test("cancel during transcription discards the late result", async () => {
	const f = await fixture();
	const reply = Promise.withResolvers<{ ok: true; text: string }>();
	FakeWorker.reply = (req) => (req.type === "transcribe" ? reply.promise : Promise.resolve({ ok: true }));
	await act(async () => { f.dictation.toggle(); });
	await speak();
	await act(async () => { f.dictation.stop(); });
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.dictation.phase, "idle");
	await act(async () => { reply.resolve({ ok: true, text: "tarde" }); });
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.dictation.error, null);
});

test("an engine failure surfaces as a localized error and ends the run", async () => {
	const f = await fixture();
	FakeWorker.reply = async (req) => (req.type === "transcribe" ? { ok: false, error: "GPU lost" } : { ok: true });
	await act(async () => { f.dictation.toggle(); });
	await speak();
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, "Whisper failed: GPU lost");
	assert.equal(dictationErrorLabel(f.dictation.error!), "Whisper could not transcribe: GPU lost");
});
