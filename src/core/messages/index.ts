/**
 * The interface dictionaries, one file per zone and language (zones keep
 * parallel work conflict-free). Spanish is the source; English mirrors it
 * key for key — each en/<zone>.ts `satisfies` its es twin, and
 * tests/i18n.test.ts checks keys and placeholders match.
 */
import type { Locale, Message } from "../i18n.ts";
import esArtifacts from "./es/artifacts.ts";
import esCommon from "./es/common.ts";
import esGraph from "./es/graph.ts";
import esKeyboard from "./es/keyboard.ts";
import esSession from "./es/session.ts";
import esSettings from "./es/settings.ts";
import esReview from "./es/review.ts";
import esExams from "./es/exams.ts";
import esShell from "./es/shell.ts";
import esOnboarding from "./es/onboarding.ts";
import enArtifacts from "./en/artifacts.ts";
import enCommon from "./en/common.ts";
import enGraph from "./en/graph.ts";
import enKeyboard from "./en/keyboard.ts";
import enSession from "./en/session.ts";
import enSettings from "./en/settings.ts";
import enReview from "./en/review.ts";
import enExams from "./en/exams.ts";
import enShell from "./en/shell.ts";
import enOnboarding from "./en/onboarding.ts";

const es = { ...esCommon, ...esSession, ...esGraph, ...esArtifacts, ...esSettings, ...esKeyboard, ...esShell, ...esReview, ...esExams, ...esOnboarding };

/** Every interface string's key. */
export type MessageKey = keyof typeof es;

const en: Record<MessageKey, Message> = { ...enCommon, ...enSession, ...enGraph, ...enArtifacts, ...enSettings, ...enKeyboard, ...enShell, ...enReview, ...enExams, ...enOnboarding };

export const MESSAGES: Record<Locale, Record<MessageKey, Message>> = { es, en };
