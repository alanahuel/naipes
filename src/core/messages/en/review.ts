import type { Message } from "../../i18n.ts";
import type es from "../es/review.ts";

/** Review: the forgetting curve (notices, review sessions). */
export default {
	"review.notice.digestTitle": { one: "{n} idea to review today", other: "{n} ideas to review today" },
	"review.notice.digestBody": "{groups} Click to start.",
	"review.notice.groupsOne": "{a}.",
	"review.notice.groupsTwo": "{a} and {b}.",
	"review.notice.groupsMore": { one: "{a}, {b} and {n} more topic.", other: "{a}, {b} and {n} more topics." },
	"review.notice.group": "{label} ({count})",
	"review.notice.eveningTitle": { one: "{n} idea left to review", other: "{n} ideas left to review" },
	"review.notice.eveningBody": { one: "A few minutes today keep it from fading.", other: "A few minutes today keep them from fading." },
	"review.sessionTitle": "Review · {date}",
	"review.opening": "Let’s start the review.",
	"review.group.sessions": "Sessions",
} satisfies Record<keyof typeof es, Message>;
