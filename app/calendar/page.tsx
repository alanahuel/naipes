import { CalendarPage } from "@/components/calendar";

export const dynamic = "force-dynamic";

/** Calendario (owner design, 2026-11-10): ?tab=week|month|events, ?day=YYYY-MM-DD. */
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string; day?: string }> }) {
	const { tab, day } = await searchParams;
	return <CalendarPage initialTab={tab} initialDay={day} />;
}
