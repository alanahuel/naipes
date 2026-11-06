# Exams with a deadline («Exámenes»)

Owner design, 2026-11-05 (decisions asked one by one; texts and mockups approved 2026-11-06). Learning toward a date: a syllabus, a standard to reach, an exhaustive placement test, and a daily plan of review, practice and teaching that adapts to the learner's answers.

## The standard

Two axes per idea, both derived (never stored):

| Axis | Meaning |
|---|---|
| Recall | FSRS probability of recall at 09:00 on the exam day, with no further study |
| Mode | the highest demand mode solved cleanly — Recordar → Discriminar → Componer |

An idea **meets** the standard when both hold and it is not «por enseñar». **Coverage** is counted per syllabus point: each point weighs the same, its score is the share of its ideas that meet; a point with no ideas yet scores 0.

| Preset | Recall | Mode | Coverage |
|---|---|---|---|
| Aprobado | 80% | Recordar | 70% |
| Notable | 90% | Discriminar | 85% |
| Sobresaliente | 95% | Componer | 95% |

«Personalizar» edits the three numbers.

## The reached mode (`src/core/exams.ts` `ideaLevel`)

Replayed from the review events (`src/core/review.ts` carries `mode` and `step` on each):

| Event | Step |
|---|---|
| practice solved, confidence ≥ threshold (or absent) | up → level = max(level, mode) |
| practice solved with low confidence; hints R1–R2 | stay |
| hints R3–R5, surrendered | miss |
| teach check Good / Hard / Again | up / stay / miss, at Recordar |

A miss drops one mode; two misses in a row at Recordar or below → «por enseñar»; in the placement test a miss with no level yet → «por enseñar». A later teach event clears it. Every practice submission carries the learner's 0–100 confidence (the practice dock's slider); a solve below the threshold also grades **Hard** in FSRS. Mock exams never grade.

## Lifecycle

1. **Draft** — title, date, syllabus (text, an attached md/txt/pdf/docx/epub whose text only seeds the syllabus, and/or knowledge folders picked in a tree — any folder at any depth, subfolders included; only folders with ideas, collapsed to the first level, names as on disk, a name filter (owner, 2026-11-06; older drafts' 2nd-level areas read back as those folders)). A draft can be deleted without finishing the wizard: the «···» menu on its card in the list and in the wizard header (owner, 2026-11-06). Deleting keeps the sessions and the graph; a mapping still running finds the exam gone and saves nothing.
2. **Mapping** — the `syllabusMapper` role (strong slot) makes ONE `submit_syllabus` call over candidate propositions (the chosen folders' ideas + word-overlap hits per syllabus line, ≤ 400): blocks → points → node ids; an empty point is «falta». The learner reviews and edits the table.
3. **Active** — the plan runs. The exam's ideas join Repaso: enrolled, exempt from the daily cap, held out until the placement test grades them, due earlier when the normal interval would reach the exam day below the exam's recall, and always reviewed once in the final window (`exams.finalWindowDays`, 3).
4. **Archived** — automatically after the date (with the final coverage and preset frozen), or by hand; the learner may note the real grade. The ideas return to the normal rhythm.

## The plan

- **Work** (`examWork`): the exhaustive placement test (climbs to the standard's mode), teaching «falta» points (full, or a short «afianzado» when the placement showed the learner knows it), consolidation for «por enseñar» ideas, mode practice, and reviews until the exam. Only the points needed for the coverage count: already meeting first, then prioritized blocks, then the cheapest.
- **Durations**: settings defaults (teach 25, afianzado 10, problem 6, review idea 2 minutes) until three measured samples of the learner's active time exist (gaps capped at 5 minutes).
- **Budget** (`planBudget`): one global set of minutes per weekday for all exams. Review minutes are spread over the study days left; the rest goes earliest-deadline-first.
- **Today** (`todayBlocks`): dated review → placement test (while pending) or mode practice → teach one point. Each block is its own session.
- **Not enough time**: the exam page says which preset the budget reaches and offers «Subir N min/día», «Bajar a …», «Priorizar bloques» — nothing changes on its own.

## Sessions

`ChatRecord.exam = { id, kind, pointId?, short?, pointIds?, levels? }`. The agents get an appendix from `src/agent/prompts/exams/` (placement, practice, teach, consolidate, mock — owner-approved texts), built from the record's frozen link. Placement problems probing a «falta» point pass `syllabusPoint` and no target. A review block is an ordinary review session scoped to the exam's ideas.

## Notices

Folded into the desktop clock (`POST /api/review/notify` → `deskNotice`): the digest gains «{exam}: ~{min} min hoy.» (or becomes «Hoy toca estudiar para {exam}» when Repaso has nothing due); the evening reminder covers an exam whose plan wasn't started. One-off notices ride the digest slot: below target (again only after it was back on track), 7 days, 1 day. Clicks open `/exams/<id>`.

## Files and API

`data/exams/<id>.json`, `data/exams/notices.jsonl`; settings section `exams` (weeklyMinutes Monday first, durations, finalWindowDays, placementBatch).

| Route | Purpose |
|---|---|
| `GET/POST /api/exams` | list (+ knowledge folders with recursive idea counts) / create a draft |
| `GET/PUT/DELETE /api/exams/[id]` | detail with the derived plan / edit, activate, archive, real grade / delete |
| `POST /api/exams/[id]/map` | start the mapping (202; 503 without a strong model) |
| `POST /api/exams/[id]/preview` | the wizard's what-if forecast |
| `POST /api/exams/[id]/sessions` | start a block: placement, practice, review, teach, mock |
| `POST /api/exams/syllabus-file` | a syllabus file → text |

## Interface

The 5th tab **Exámenes** (`components/exams.tsx`): the list, the 4-step wizard, the exam page (Hoy, Tu nivel, Plan · próximos 14 días, Temario, Simulacro in the last 7 days); Inicio «Hoy para tu examen»; Settings → Exámenes; exam notices in the bell; an exam session's batch end returns to the exam or opens the next batch.
