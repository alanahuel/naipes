# Dictation

Two engines, one setting (`settings.json` → `dictation`): **local Whisper** (the default, owner 2026-11-08) and **Deepgram** (BYOK key). The language setting is shared; the engine and the Whisper model are chosen in **Settings → Connections → Dictation**.

Why not the AI subscriptions? Claude (Claude Code's `voice_stream`) and ChatGPT (Realtime / transcribe) only offer speech-to-text through undocumented internal endpoints. They are fragile and conflict with the subscriptions' terms, so Naipes doesn't use them.

## Local Whisper

| Piece | Where |
|---|---|
| Model manifest (repo, pinned revision, files with size + sha256), language mapping | `src/core/whisper.ts` |
| Downloads / cancel / delete / serving guard | `src/server/whisper-models.ts` |
| `GET /api/stt/whisper` (status), `POST`/`DELETE /api/stt/whisper/:model` | `app/api/stt/whisper/` |
| `GET /stt-models/whisper-<id>/<file>` (model files for the engine) | `app/stt-models/[...path]/route.ts` |
| Engine, main thread (device detection, worker, requests) | `components/whisper-engine.ts` |
| Engine, Web Worker (transformers.js) | `components/whisper-worker.ts` |
| Run flow (capture → transcribe at stop → append) | `components/dictation.tsx` |
| Settings UI | `components/dictation-engine-settings.tsx` |
| ONNX runtime files → `public/ort/` (gitignored) | `scripts/copy-ort-wasm.mjs` (runs before `dev`/`build`) |

### Models

`onnx-community/whisper-{base,small,large-v3-turbo}`, loaded with a **q4 encoder + q4 merged decoder**: that dtype runs on both WebGPU and WASM. They download from Hugging Face at a **pinned revision**; every file is checked for size **and** sha256 before the folder is renamed into place (`<data>/models/whisper/whisper-<id>/`). A partial download lives in `whisper-<id>.part/` and is removed on cancel or failure. Sizes: 145 / 302 / 762 MB. The factory default is Turbo.

To bump a model, update its revision, sizes and hashes in `WHISPER_MODELS`. The `tests/whisper.test.ts` manifest test guards the shape.

### Run flow

1. Click → read the settings → `GET /api/stt/whisper`. If the model is missing, the error deep-links to Settings (`WHISPER_ROW`) **before** the mic opens.
2. `prepareWhisper` starts loading the model in the worker **while the learner speaks** (7–15 s cold).
3. The capture worklet's linear16 frames (16 kHz) are kept for the whole run. Nothing is streamed.
4. Stop → `pcm16ToFloat32` → `transcribeWhisper` (30 s windows, 5 s stride) → the text joins the deferred buffer → the usual single flush. Cancel/Esc bumps the generation, and the late result is dropped.

Language: `whisperLanguage()` collapses regions (`es-419` → `es`), `multi` → auto-detect. A language Whisper lacks would also fall back to auto-detect, and the picker flags it. Today every Deepgram language has a Whisper equivalent.

### Device

`whisperDevice()` uses WebGPU when the adapter is a **real GPU**. SwiftShader and fallback adapters count as no GPU: in phase 0, a transcription on SwiftShader never finished. Otherwise it uses WASM, and Settings shows the slow-CPU notice (owner: works anyway, with a notice).

- **Linux:** Chromium keeps WebGPU behind `enable-unsafe-webgpu` + `enable-features=Vulkan`. `electron/main.cjs` appends both on Linux only. On Wayland, Chromium logs that Vulkan "is not compatible" with the ozone platform. That only concerns compositing: WebGPU (Dawn) uses Vulkan anyway, and the app renders normally (verified 2026-11-08).
- **macOS / Windows:** WebGPU is on by default (Metal / D3D12).
- WASM runs single-threaded: Naipes doesn't set COOP/COEP, so the page isn't cross-origin isolated. WebGPU doesn't care.

### Gotchas (found the hard way)

- **The worker imports nothing from the app**, not even `@/src/core`. The barrel pulls markdown helpers that touch `document` at module evaluation, and the worker dies before its first message. The main thread sends `{ dir, dtype }` with every request.
- **Boot handshake:** the worker posts `{ ready: true }` once its module evaluated. A module-evaluation failure raises no `error` event, so without the handshake a run would hang in "stopping" forever. If the worker isn't ready within 30 s, everything pending fails with "Whisper engine did not start".
- **Model files are served outside `/api`.** Worker requests never carry the desktop capability header (it's attached to the main frame only, `electron/desktop-api.cjs`). Only manifest files of a fully downloaded model resolve; anything else returns 404.
- **`localModelPath` must be relative** (`/stt-models/`). transformers.js 4.3.2 skips its local metadata check for full URLs, so the processor never loads.
- **ONNX runtime:** transformers.js defaults to fetching it from cdn.jsdelivr.net. Naipes serves `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` from `/ort/`, the only build it uses on WebGPU and WASM alike.
- **Dependencies:** `onnxruntime-node` (~288 MB) and `sharp` are overridden away in `pnpm-workspace.yaml`. Naipes only uses the web build.

### Measured (owner's Ryzen + Vega, Electron 44, 2026-11-08)

| Model | Device | Load | 12 s clip | 43–55 s clip |
|---|---|---|---|---|
| Base | WebGPU | 7.4 s | 2.2 s | 2.4 s |
| Small | WebGPU | 7.3 s | 2.4 s | 7.6 s |
| Turbo | WebGPU | 14.9 s | 2.8 s | 12.6 s |
| Small | WASM (threads) | 5.6 s | 19 s | 54 s |

In the real app, the first Turbo dictation after a reload (14 s of speech) lands **~2.8 s after Stop**: the model loads while the learner speaks.

## Deepgram

Unchanged: `/api/stt/token` mints a short-lived token, and the renderer streams linear16 audio over a WebSocket (see the header of `components/dictation.tsx`). Its key row and setup hint only show while Deepgram is the engine.
