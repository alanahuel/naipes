/**
 * Local Whisper dictation (owner, 2026-11-08) — the browser-safe facts:
 * which models exist, which files each one needs (pinned revision + size +
 * sha256, so a download is verifiable), and how the shared «dictation
 * language» setting (Deepgram codes) maps onto Whisper's languages.
 *
 * The engine runs in the renderer (transformers.js → onnxruntime-web,
 * WebGPU with a WASM fallback); the server only stores and serves the
 * files (src/server/whisper-models.ts). Phase-0 measurements on the
 * owner's machine chose q4 for both halves of every model: it runs on
 * WebGPU and WASM alike.
 */
import type { DictationLanguage } from "./dictation.ts";

export type WhisperModelId = "base" | "small" | "large-v3-turbo";
export type DictationEngine = "whisper" | "deepgram";

export const DICTATION_ENGINES: readonly DictationEngine[] = ["whisper", "deepgram"];

export function isDictationEngine(value: unknown): value is DictationEngine {
	return value === "whisper" || value === "deepgram";
}

export interface WhisperModelFile {
	/** Path inside the model folder (and inside the Hugging Face repo). */
	path: string;
	size: number;
	sha256: string;
}

export interface WhisperModelInfo {
	id: WhisperModelId;
	label: string;
	/** Hugging Face repo — downloads are pinned to `revision`. */
	repo: string;
	revision: string;
	files: readonly WhisperModelFile[];
}

/** The transformers.js dtype every model is loaded with (files below). */
export const WHISPER_DTYPE = { encoder_model: "q4", decoder_model_merged: "q4" } as const;

export const WHISPER_MODELS: readonly WhisperModelInfo[] = [
	{
		id: "base",
		label: "Base",
		repo: "onnx-community/whisper-base",
		revision: "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c",
		files: [
			{ path: "config.json", size: 2243, sha256: "f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b" },
			{ path: "generation_config.json", size: 3832, sha256: "61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0" },
			{ path: "preprocessor_config.json", size: 339, sha256: "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d" },
			{ path: "tokenizer.json", size: 2480466, sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566" },
			{ path: "tokenizer_config.json", size: 282682, sha256: "2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573" },
			{ path: "onnx/encoder_model_q4.onnx", size: 18772451, sha256: "9d4e9c31e8559e71de3e0e49d60b830951484699ef53747a4a06261bbbc8cb88" },
			{ path: "onnx/decoder_model_merged_q4.onnx", size: 123602419, sha256: "09f83b71ceedc97dab1d90b914715dc532a646a147abda11d83c64867b7c319c" },
		],
	},
	{
		id: "small",
		label: "Small",
		repo: "onnx-community/whisper-small",
		revision: "36050c46d777d46dc4b5f43f6d90574fc38f8732",
		files: [
			{ path: "config.json", size: 2227, sha256: "457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18" },
			{ path: "generation_config.json", size: 3893, sha256: "f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0" },
			{ path: "preprocessor_config.json", size: 339, sha256: "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d" },
			{ path: "tokenizer.json", size: 2480466, sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566" },
			{ path: "tokenizer_config.json", size: 282683, sha256: "2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce" },
			{ path: "onnx/encoder_model_q4.onnx", size: 66182104, sha256: "9f088ad0fe15ba2cf094c9fb22ac7fe1111fc9ef317c1e4d1f6a3bca38a931ba" },
			{ path: "onnx/decoder_model_merged_q4.onnx", size: 233149327, sha256: "795c61b344576719c2b249cc9911c78b4cc552c8c6a5407be21a3380a0791b13" },
		],
	},
	{
		id: "large-v3-turbo",
		label: "Large-v3-turbo",
		repo: "onnx-community/whisper-large-v3-turbo",
		revision: "360ebcde2559d60bb474678be3c1de9ef347d01a",
		files: [
			{ path: "config.json", size: 1332, sha256: "35cd83669f75bc2867f3b3a4461850392d5e308cd6ea951c3700539883c28df1" },
			{ path: "generation_config.json", size: 3897, sha256: "16f95291d2f47c944d3c2b19390bba7965666555c1ea2a0bdc850d1fab45612f" },
			{ path: "preprocessor_config.json", size: 340, sha256: "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711" },
			{ path: "tokenizer.json", size: 2480617, sha256: "6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca" },
			{ path: "tokenizer_config.json", size: 282843, sha256: "844b642c73a91359722f47b35705f7174686df33d252695d8572cf9ac03a6389" },
			{ path: "onnx/encoder_model_q4.onnx", size: 424942775, sha256: "7e64b20dd7b556cb7a2c1c65d9fbf31af985323c006f993d2a9dd10083547d78" },
			{ path: "onnx/decoder_model_merged_q4.onnx", size: 334147222, sha256: "8b933ac24074a24a1635084d06a4ed37e387ef22d980f184a5fc27418e9ceeb8" },
		],
	},
];

export const WHISPER_MODEL_IDS: readonly WhisperModelId[] = WHISPER_MODELS.map((m) => m.id);

export function isWhisperModelId(value: unknown): value is WhisperModelId {
	return typeof value === "string" && (WHISPER_MODEL_IDS as readonly string[]).includes(value);
}

export function whisperModel(id: WhisperModelId): WhisperModelInfo {
	return WHISPER_MODELS.find((m) => m.id === id)!;
}

export function whisperModelBytes(id: WhisperModelId): number {
	return whisperModel(id).files.reduce((sum, f) => sum + f.size, 0);
}

/** The model folder name transformers.js resolves against localModelPath. */
export function whisperModelDir(id: WhisperModelId): string {
	return `whisper-${id}`;
}

/** Whisper's languages (transformers.js WHISPER_LANGUAGES, 99 codes). */
const WHISPER_LANGUAGE_CODES = new Set([
	"en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi", "vi",
	"he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk",
	"te", "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
	"gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
	"ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su",
]);

/**
 * The shared dictation language as Whisper sees it (owner: one setting for
 * both engines). Regional variants collapse to their base language
 * (es-419 → es, zh-TW → zh); "multi" → "auto" (Whisper detects the
 * language); null = Whisper has no such language (the picker flags it).
 */
export function whisperLanguage(code: DictationLanguage): string | "auto" | null {
	if (code === "multi") return "auto";
	const base = code.split("-")[0]!.toLowerCase();
	return WHISPER_LANGUAGE_CODES.has(base) ? base : null;
}
