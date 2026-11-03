import { Home } from "@/components/home";
import { readSettingsRecord } from "@/src/server";
import { slotsConfigured } from "@/src/core";

// Dynamic: the configured state is server-rendered into the page (the
// setup CTA's truth on the first frame).
export const dynamic = "force-dynamic";

/** Inicio: «¿Qué quieres aprender?» + «Seguir con». */
export default function HomePage() {
	const record = readSettingsRecord();
	return <Home initialConfigured={slotsConfigured(record?.models)} />;
}
