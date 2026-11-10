import { translator, type Translate } from "@/components/i18n";

const english = translator("en");

/** Compact "how long ago" ("ahora mismo", "hace 5 min", "hace 3 horas",
 *  "hace 2 días"), then an ISO date beyond a week (unambiguous in any
 *  locale, and it sorts). English by default (tests); callers pass `t`. */
export function timeAgo(iso: string, now = new Date(), t: Translate = english): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return t("time.justNow");
	const min = Math.floor(ms / 60_000);
	if (min < 60) return t("time.minutesAgo", { n: min });
	const h = Math.floor(min / 60);
	if (h < 24) return t("time.hoursAgo", { n: h });
	const d = Math.floor(h / 24);
	if (d < 7) return t("time.daysAgo", { n: d });
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}
