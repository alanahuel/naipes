import { redirect } from "next/navigation";

/** Settings are pages now; the bare URL lands on «Tu IA». */
export default function SettingsIndex() {
	redirect("/settings/ai");
}
