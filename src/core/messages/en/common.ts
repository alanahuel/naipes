import type { Message } from "../../i18n.ts";
import type es from "../es/common.ts";

export default {
	"common.cancel": "Cancel",
	"common.close": "Close",
	"common.save": "Save",
	"common.delete": "Delete…",
	"common.moreOptions": "More options",
	"common.loading": "Loading…",
	"common.back": "Back",
	"common.open": "Open",
	"common.retry": "Try again",
	"common.somethingFailed": "Something went wrong",
	"common.tutor": "Your tutor",
	"common.language": "Language",
	"common.languageHint": "The interface language. What your tutor writes follows each session's language.",
} satisfies Record<keyof typeof es, Message>;
