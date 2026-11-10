# Calendario

Owner design, 2026-11-10 (decisions asked one by one; plan approved «tal cual»; the eight mockups, the «Preparar clase» prompt and the notice texts approved). One calendar shared by the exams and Repaso: organize the week with flexibility, the plan recalculates on its own when a day is missed, sessions can be split freely, and classes, seminars or your own study count for an exam.

## The model (`src/core/calendar.ts`, pure)

| Piece | Rule |
|---|---|
| Availability | the minutes per weekday (`exams.weeklyMinutes`, edited in Settings → Calendario) + optional usual slots (`calendar.slots`) + per-date overrides (`dayMinutes`, the ✎ on a day) |
| Events | class · seminar · tutoring · own study · other; single or weekly until a date; an occurrence can be cancelled or moved (`occurrences["<series>@<original day>"]`) |
| «Consume mi tiempo» | a per-event switch: on, the event takes its minutes from the day; off, it only occupies its hours |
| Imported (.ics) | read-only; occupy their hours (gray), never minutes unless marked; the learner sets exam, kind, consume per series (`importedMeta`) |
| Class topics | planned beforehand (`planned`) and confirmed afterwards (`confirmed`, `[]` = «Nada del temario»). A confirmed point becomes a short afianzado (`PointStatus.classCovered`: no placement, a consolidate session). A class with no topics is statistics only |
| Planned topic | the plan does not teach it before that class; a «Preparar clase» session (10 min, `calendar.prepareMinutes`) is planned the day of the class (`ExamSessionKind` `prepare`, prompt `prepare.md`) |
| Concrete window | the next 7 days get concrete cards; beyond, minutes per exam and day. Allocated minutes no card takes yet (what follows depends on the placement test) show as «Estimación» |
| Day order | Repaso (ideas of no live exam, consumes the day first) → «Preparar clase» → per exam, nearest first: dated review → placement test or mode practice → teach (what a taught point opens is practised from the next day) |
| Hours | automatic cards get a suggested hour in the free part of the day's slots (dashed); no room → no hour |

### Anchored, started, late

`PinnedSession` = a session the learner touched (`anchored`: moved, hour set, resized, split) or started from a card (`chatId`, not anchored). The planner lays everything else out around them and takes their minutes from their exam's work.

- An anchored sitting missed on a past day is **late** («Atrasadas»): it never moves alone — «Reprogramar» or «Descartar».
- A started-only session left half-done on a past day is **released**: its content goes back to the automatic plan (owner: «lo que falte se recalcula»).
- «Quitar ancla» returns a card to automatic (a started one keeps its conversation link).
- **Split** = the same conversation in several sittings: the second part continues the chat. A sitting is done once its share of the active minutes (teach) or of the batch (review/practice/placement) is reached; the last one when the content is.
- **Done by content**, any day: a point taught (and sorted), a batch finished, a preparation used (80 % of its minutes, or the class began).

The plan is computed once per request with the exam state (`src/server/calendar-context.ts` inside `getExamsState`): class topics feed `computeExamStatus`, each date's budget (minus consuming events, pinned sittings, Repaso, preparations, today's study already done) feeds `planBudget` (`budgetFor`), then `planCalendar` lays the cards out. The exam page («Hoy», «Plan · próximos 14 días»), Inicio and the calendar all read that one plan.

## .ics (`src/core/ics.ts`)

VEVENTs with DTSTART/DTEND/DURATION, RRULE (DAILY · WEEKLY + BYDAY · MONTHLY by month day · YEARLY; INTERVAL, COUNT, UNTIL), EXDATE, RECURRENCE-ID overrides, STATUS:CANCELLED; TZID via Intl, UTC, floating = local. Subscriptions refresh every 6 h (and «Actualizar»); `webcal://` reads as https. Two-way Google sync (OAuth) is a later, separate phase (the owner registers the Google Cloud client).

## Notices

The desktop minute clock asks `POST /api/review/notify?kind=digest|evening|calendar`:

- **digest** — the day's agenda: «Hoy: {n} sesiones · ~{min} min» / the first three cards with their hour «… y {k} más.» (the review digest's window and once-a-day rules). The exams' one-off countdown notices still ride the digest slot.
- **evening** — only when sessions are left: «Te quedan {n} sesiones de hoy» / «~{min} min. Lo que no hagas se recoloca solo.»
- **calendar** — «{x} a las {hora}» / «Empieza en {n} min.» before a FIXED hour (classes, events, timed sessions — never suggested hours), `calendar.alertMinutes` before (0 = off); after a class with an exam «¿Qué se dio en {clase}?» / «Márcalo y tu plan se ajusta.» (own study: «¿Hiciste «{t}»?»). Each once (`data/calendar/notices.jsonl`).

Every click opens `/calendar`; the bell gets the same text (server event `calendar-notice`).

## Files and API

`data/calendar/calendar.json` (events, occurrence states, per-date minutes, subscriptions + series meta, pinned sessions), `data/calendar/feeds/<id>.json` (the last fetch, expanded), `data/calendar/notices.jsonl`; settings section `calendar` (`slots`, `alertMinutes`, `prepareMinutes`).

| Route | Purpose |
|---|---|
| `GET /api/calendar?from&to` | the days (≤ 62; default today + 6), late, to confirm, live exams' points, events, subscriptions, settings |
| `POST /api/calendar/events`, `PUT/DELETE /api/calendar/events/[id]` | hand-made events |
| `PUT /api/calendar/occurrences` | one occurrence: cancelled, moved, planned, confirmed, done |
| `PUT /api/calendar/days` | a date's minutes (`null` = the weekday's) |
| `POST /api/calendar/sessions` | `move` · `resize` · `split` · `merge` · `release` (anchors) |
| `POST /api/calendar/sessions/start` | start or continue the session behind a card |
| `POST /api/calendar/feeds`, `POST/PUT/DELETE /api/calendar/feeds/[id]` | subscribe, refresh, rename, remove |
| `PUT /api/calendar/series` | an imported series: exam, kind, consume, planned |

## Interface (`components/calendar.tsx`)

The 6th tab **Calendario** (`?tab=week|month|events`, `?day=` for the agenda): **Agenda** (Atrasadas and «¿Qué se dio?» first; seven days with «N de M min ✎»; fixed vs ·suggested· hours, 📌 anchored; «Empezar/Continuar» + ⋯; «Ver más días»), **Semana** (hour grid 07–23, «sin hora» row, slots shaded, drag = move + anchor, bottom edge = length, click = menu; three days when narrow), **Mes** (planned/available + load bar, ★ exam dates, • events; a day opens the agenda), **Eventos** (your events + the event dialog, subscriptions and their series). Inicio's **Hoy** card replaces «Para repasar hoy» and «Hoy para tu examen». **Settings → Calendario**: minutes per weekday, usual slots, alert lead, «Preparar clase» length (Settings → Exámenes links there).
