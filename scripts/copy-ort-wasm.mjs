/**
 * copy-ort-wasm.mjs — put onnxruntime-web's WASM runtime into public/ort/
 * (local Whisper dictation, owner 2026-11-08). transformers.js otherwise
 * fetches it from cdn.jsdelivr.net at runtime; Naipes serves it itself.
 * Only the "asyncify" build is used (WebGPU and WASM alike — measured in
 * the phase-0 spike). public/ort/ is gitignored; `dev` and `build` run
 * this first, and build-server.mjs ships public/ with the server.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// node_modules is hoisted (pnpm-workspace.yaml) and the package's exports
// map hides package.json — address the one installed copy directly.
const dist = path.join(ROOT, "node_modules", "onnxruntime-web", "dist");
const out = path.join(ROOT, "public", "ort");
const FILES = ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const file of FILES) fs.copyFileSync(path.join(dist, file), path.join(out, file));
console.log(`copy-ort-wasm: ${FILES.length} files → public/ort/`);
