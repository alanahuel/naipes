import type { Message } from "../../i18n.ts";
import type es from "../es/keyboard.ts";

export default {
	"keyboard.toggleDictation": "Toggle dictation",
	"keyboard.openSettings": "Open settings",
	"keyboard.openModelPicker": "Model selector",
	"keyboard.cycleThinking": "Cycle thinking level",
	"keyboard.goHome": "Go to Home",
	"keyboard.goSessions": "Go to My sessions",
	"keyboard.goKnowledge": "Go to Knowledge",
	"keyboard.sessionsSearch": "Search sessions",
	"keyboard.jumpGraph": "Graph view",
	"keyboard.newSession": "New session",
	"keyboard.renameSession": "Rename session",
	"keyboard.toggleUserThinking": "Toggle all your thinking",
	"keyboard.find": "Find",
	"keyboard.cheatSheet": "Shortcut cheat sheet",
	"keyboard.questionFocus": "Question · focus thinking ↔ rows",
	"keyboard.questionNextRow": "Question · next row",
	"keyboard.questionPrevRow": "Question · previous row",
	"keyboard.questionPickRow": "Question · pick row",
	"keyboard.questionSubmit": "Question · submit",
} satisfies Record<keyof typeof es, Message>;
