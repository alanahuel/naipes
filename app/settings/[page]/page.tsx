import { notFound } from "next/navigation";
import { SettingsPage } from "@/components/settings/settings-page";
import { isSettingsPage } from "@/components/settings/pages";

/** One settings page (Tu IA, Conexiones, Apariencia, Atajos, Avanzado, Idioma). */
export default async function Page({
	params,
	searchParams,
}: {
	params: Promise<{ page: string }>;
	searchParams: Promise<{ row?: string }>;
}) {
	const [{ page }, { row }] = await Promise.all([params, searchParams]);
	if (!isSettingsPage(page)) notFound();
	return <SettingsPage page={page} initialRow={row} />;
}
