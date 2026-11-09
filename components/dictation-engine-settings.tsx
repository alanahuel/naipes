"use client";

/**
 * Settings → Connections → Dictation: the engine choice and the local
 * Whisper models (owner, 2026-11-08). Engine: «Whisper local» (default) or
 * «Deepgram». Under Whisper: the model choice, then one row per model with
 * its disk state — Descargar / «Descargando… N %» · Cancelar /
 * Descargado · Eliminar — and, on a computer without a real WebGPU
 * adapter, the slow-CPU notice (owner: WASM works anyway, with a notice).
 */
import { useCallback, useEffect, useState } from "react";
import { WHISPER_MODELS, type DictationEngine, type WhisperModelId } from "@/src/core";
import { Button } from "@/components/ui/button";
import { SettingsRow, ThinSelect } from "@/components/settings/controls";
import { useDictationLanguage } from "@/components/dictation-preference";
import { useDictationActive } from "@/components/dictation-state";
import { whisperDevice, type WhisperDevice } from "@/components/whisper-engine";
import { useT } from "@/components/i18n";

interface ModelStatus {
	id: WhisperModelId;
	label: string;
	bytes: number;
	state: "missing" | "downloading" | "ready" | "error";
	received?: number;
	error?: string;
}

/** 727 MB / 1.2 GB — decimal units, as download sizes are quoted. */
export function formatModelSize(bytes: number): string {
	return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** The engine choice — always shown at the top of the Dictation group. */
export function DictationEngineSetting() {
	const t = useT();
	const { engine, saving, save } = useDictationLanguage();
	const active = useDictationActive();
	return <SettingsRow label={t("settings.dictation.engine")} hint={t("settings.dictation.engineHint")} testid="dictation-engine-row">
		<ThinSelect
			value={engine ?? ""}
			onChange={(next) => { void save({ engine: next as DictationEngine }); }}
			options={[
				{ value: "whisper", label: t("settings.dictation.engineWhisper") },
				{ value: "deepgram", label: t("settings.dictation.engineDeepgram") },
			]}
			ariaLabel={t("settings.dictation.engine")}
			testid="dictation-engine"
			disabled={engine === undefined || saving || active}
		/>
	</SettingsRow>;
}

/** The Whisper model choice + per-model downloads (engine = whisper). */
export function WhisperModelsSetting() {
	const t = useT();
	const { whisperModel, saving, save } = useDictationLanguage();
	const active = useDictationActive();
	const [models, setModels] = useState<ModelStatus[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [device, setDevice] = useState<WhisperDevice | null>(null);

	useEffect(() => { void whisperDevice().then(setDevice); }, []);

	const apply = useCallback(async (res: Response) => {
		if (!res.ok) throw new Error(String(res.status));
		const body = (await res.json()) as { models: ModelStatus[] };
		setModels(body.models);
		setFailed(false);
	}, []);
	const refresh = useCallback(() => fetch("/api/stt/whisper").then(apply).catch(() => setFailed(true)), [apply]);

	useEffect(() => { void refresh(); }, [refresh]);
	// Poll while anything downloads (progress lives on the server).
	const downloading = models?.some((m) => m.state === "downloading") ?? false;
	useEffect(() => {
		if (!downloading) return;
		const id = setInterval(() => { void refresh(); }, 500);
		return () => clearInterval(id);
	}, [downloading, refresh]);

	const act = (id: WhisperModelId, method: "POST" | "DELETE") =>
		fetch(`/api/stt/whisper/${id}`, { method }).then(apply).catch(() => setFailed(true));

	return <>
		<SettingsRow label={t("settings.dictation.model")} hint={t("settings.dictation.modelHint")} testid="whisper-model-row">
			<ThinSelect
				value={whisperModel ?? ""}
				onChange={(next) => { void save({ whisperModel: next as WhisperModelId }); }}
				options={WHISPER_MODELS.map((m) => ({ value: m.id, label: m.label }))}
				ariaLabel={t("settings.dictation.model")}
				testid="whisper-model"
				disabled={whisperModel === undefined || saving || active}
			/>
		</SettingsRow>
		<div className="flex flex-col gap-1 px-1" data-testid="whisper-models">
			{(models ?? []).map((m) => (
				<div key={m.id} className="flex items-center justify-between gap-3 py-0.5 text-xs" data-testid={`whisper-model-${m.id}`}>
					<span className="min-w-0 truncate">
						<span className={m.id === whisperModel ? "font-medium text-foreground" : "text-muted-foreground"}>{m.label}</span>
						<span className="ml-2 text-muted-foreground/70">{formatModelSize(m.bytes)}</span>
					</span>
					<span className="flex shrink-0 items-center gap-2">
						{m.state === "downloading" && <>
							<span className="tabular-nums text-muted-foreground">
								{t("settings.dictation.downloading", { percent: String(Math.floor(((m.received ?? 0) / m.bytes) * 100)) })}
							</span>
							<Button variant="outline" size="sm" data-testid={`whisper-cancel-${m.id}`} onClick={() => void act(m.id, "DELETE")}>
								{t("settings.dictation.cancel")}
							</Button>
						</>}
						{m.state === "ready" && <>
							<span className="text-muted-foreground">{t("settings.dictation.ready")}</span>
							<Button variant="outline" size="sm" disabled={active && m.id === whisperModel} data-testid={`whisper-delete-${m.id}`} onClick={() => void act(m.id, "DELETE")}>
								{t("settings.delete")}
							</Button>
						</>}
						{(m.state === "missing" || m.state === "error") && <>
							{m.state === "error" && <span className="text-destructive" title={m.error}>{t("settings.dictation.downloadFailed")}</span>}
							<Button variant="outline" size="sm" data-testid={`whisper-download-${m.id}`} onClick={() => void act(m.id, "POST")}>
								{m.state === "error" ? t("settings.retry") : t("settings.dictation.download")}
							</Button>
						</>}
					</span>
				</div>
			))}
			{failed && <p role="alert" className="text-2xs text-destructive">{t("settings.dictation.statusFailed")}</p>}
			{device === "wasm" && <p data-testid="whisper-no-gpu" className="text-2xs leading-relaxed text-muted-foreground/70">{t("settings.dictation.noGpu")}</p>}
		</div>
	</>;
}
