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

## Lifecycle (v2, owner 2026-11-06: the syllabus leads)

1. **Temario** — title, date, the guidelines (text, or an md/txt/pdf/docx/epub whose text seeds them), **Materiales** (research sources only — files stored in `data/exams/<id>/materials/`, page photos OCR'd, web links; never syllabus, never the graph), **Carpetas** (a tree of every knowledge-folder folder holding notes, read or not — «(N ideas)» / «(N notas · sin leer)»; tri-state at any depth: a click sets a subtree, any descendant can be unchecked, a partial folder keeps its loose notes; stored as `folders` recursive + `directFolders` loose notes only) and an optional **Contexto** (type, exam/subject, school or body, location, sitting — prefilled from the date's year — goal). Creating it makes a draft. A draft can be deleted from its «···» menu.
2. **Estándar** — chosen before the research: it sets the research depth. «Investigar →»: unread folders in the scope get a notice («Se añadirán a tu conocimiento…»); confirmed, they are added to Settings → Knowledge (a partial folder with loose notes is added whole — the connection reads whole folders) and read first (mapping state `reading`, «Leyendo tus carpetas… x de N»; failures listed later).
3. **Investigación** — the `syllabusMapper` (strong slot) outlines the guidelines into blocks → points (`running`), then the **exam researcher** (`src/agent/subagents/exam-researcher.ts`, owner-approved prompt) runs block by block (`researching`) producing each point's **target ideas** (≤ 12, depth by preset; «Personalizar» follows its mode): from the materials (`read_material`), the web (official guide for the sitting first, recent past papers; old material flagged `outdated`, each source with its year) and the model's knowledge, each linked to the candidate graph ideas that express it. Web search: Claude Code's own WebSearch when connected (`src/server/exam-research-io.ts` — one `claude -p` call per query, only WebSearch allowed, the cheap slot's model), else Tavily/Brave, else none («Sin búsqueda web»). A failed block keeps what was done; «Reintentar» resumes.
4. **Revisar** — blocks → points → target ideas with source and links; edit, remove, add, unlink; «Volver a investigar este punto / todo».
5. **Tiempo** → **Active**. Target ideas live in the exam, not the graph: they enter it only when taught. The exam's ideas join Repaso as before (exempt from the cap, due earlier for the date, a final review in the last days).
6. **Archived** — after the date (final coverage frozen) or by hand.

Exams made before v2 keep their point links; the exam page offers «Investigar temario» to add target ideas to the points without them.

## Target ideas and ampliación

- A researched point's score = mastered targets / targets; a target is mastered only when ALL its linked ideas meet the standard (an unlinked one counts 0). Coverage is still per point.
- Placement: each unlinked target gets its own recall problem (`syllabusPoint` = the target id, prompt `placement-targets.md`); known (clean, confidence ≥ threshold) → a short consolidation, else taught. A teach session lists the targets it establishes (`ChatExamLink.targetIds`, frozen).
- The tutor may bring in related ideas without asking (teach/consolidate prompts). After each extraction of an exam teach session the **sorter** (`exam-sorter.ts`, cheap slot) links every newly born idea to the target it expresses or marks it **ampliación** (`point.extension`). Ideas born in **«Profundizar»** sessions (kind `deepen`, prompt `deepen.md`, on demand outside the plan) are ampliación directly. Ampliación ideas get dated review but never count; the exam page moves ideas by hand («Pasar a ampliación» / «Pasar al punto»), which wins over the sorter.

## Point types: syllabus, subject rules, tutor instructions (owner 2026-11-06)

- Every block has a type — **Temario** (`syllabus`, the default), **Instrucciones de la asignatura** (`rules`: how the exam runs — allowed/forbidden, what scores, timing, format) or **Instrucciones para el tutor** (`tutor`: how to teach and check) — and its points inherit it unless they carry their own (`SyllabusBlock.kind`, `SyllabusPoint.kind`, `pointKind`). Setting a block's type resets its points' own.
- The outline proposes the types (mapper rule 4); new exams are `classified`. Older exams get «Clasificar temario» (`exam-classifier.ts`, strong slot, `POST /api/exams/[id]/classify`).
- The research turns instruction points into concrete **rules** (stored in `targets`, ≤ 12, with source and year, never linked to graph ideas) — subject rules from the official guide and marking criteria first.
- Only syllabus points are studied (`studyPoints`): coverage, placement, plan, sorter, «Profundizar». Changing a type researches nothing (`setPointKind`; Revisar edits locally, the exam page via `POST /api/exams/[id]/kind`): the point is marked pending (`pendingFrom` = the type its content was made for), its old content is hidden («Pendiente de investigar»), and setting the old type back cancels it. «Investigar cambios (N)» (research `{ mode: "pending" }`) researches them; in Revisar «Confirmar →» does it first and then goes on to step 5. The research settles a point by replacing its content and dropping its ampliación.
- Every exam session (placement, teach, consolidate, deepen, practice, mock) gets `instructions.md` appended with the rules and tutor instructions (an empty part left out; an unresearched point stands in with its text): the tutor checks each reply against them and may step outside an exam rule briefly when it truly helps, saying so and why.
- Revisar has a type selector per block and point («Reglas (n)» for instruction points); the exam page shows only studied points under Temario, and two editable sections «Instrucciones de la asignatura» / «Instrucciones para el tutor».

## The plan

- **Work** (`examWork`): the exhaustive placement test (climbs to the standard's mode), teaching «falta» points (full, or a short «afianzado» when the placement showed the learner knows it), consolidation for «por enseñar» ideas, mode practice, and reviews until the exam. Only the points needed for the coverage count: already meeting first, then prioritized blocks, then the cheapest.
- **Durations**: settings defaults (teach 25, afianzado 10, problem 6, review idea 2 minutes) until three measured samples of the learner's active time exist (gaps capped at 5 minutes).
- **Budget** (`planBudget`): one global set of minutes per weekday for all exams. Review minutes are spread over the study days left; the rest goes earliest-deadline-first.
- **Today** (`todayBlocks`): dated review → placement test (while pending) or mode practice → teach one point. Each block is its own session.
- **Not enough time**: the exam page says which preset the budget reaches and offers «Subir N min/día», «Bajar a …», «Priorizar bloques» — nothing changes on its own.

## Sessions

`ChatRecord.exam = { id, kind, pointId?, short?, pointIds?, levels?, targetIds? }` (kind ∈ placement, practice, review, teach, mock, deepen). The agents get an appendix from `src/agent/prompts/exams/` (placement, placement-points, placement-targets, practice, teach, consolidate, mock, deepen — owner-approved texts), built from the record's frozen link, plus `instructions.md` (the exam's rules and tutor instructions) in every one of them. Placement problems probing a «falta» point pass `syllabusPoint` and no target. A review block is an ordinary review session scoped to the exam's ideas.

## Notices

Folded into the desktop clock (`POST /api/review/notify` → `deskNotice`): the digest gains «{exam}: ~{min} min hoy.» (or becomes «Hoy toca estudiar para {exam}» when Repaso has nothing due); the evening reminder covers an exam whose plan wasn't started. One-off notices ride the digest slot: below target (again only after it was back on track), 7 days, 1 day. Clicks open `/exams/<id>`.

## Files and API

`data/exams/<id>.json`, `data/exams/notices.jsonl`; settings section `exams` (weeklyMinutes Monday first, durations, finalWindowDays, placementBatch).

| Route | Purpose |
|---|---|
| `GET/POST /api/exams` | list / create a draft (with context) |
| `GET/POST /api/exams/folders` | the wizard's folder tree / what «Leer y mapear» adds |
| `POST/DELETE /api/exams/[id]/materials` | add a material (multipart file or `{ url }`) / remove one |
| `POST /api/exams/[id]/research` | resume (`{}`), the pending type changes (`{ mode: "pending" }`), redo all (`{ mode: "all" }`) or one point (`{ pointId }`) |
| `POST /api/exams/[id]/kind` | change a block's or point's type (`{ blockId, pointId?, kind }`); changed points wait as pending |
| `POST /api/exams/[id]/classify` | «Clasificar temario»: the model types blocks and points, changed ones are researched again |
| `GET/PUT/DELETE /api/exams/[id]` | detail with the derived plan / edit, activate, archive, real grade / delete |
| `POST /api/exams/[id]/map` | start read → outline → research (202; 503 without a strong model) |
| `POST /api/exams/[id]/preview` | the wizard's what-if forecast |
| `POST /api/exams/[id]/sessions` | start a block: placement, practice, review, teach, mock, deepen |
| `POST /api/exams/syllabus-file` | a syllabus file → text |

## Interface

The 5th tab **Exámenes** (`components/exams.tsx`): the list, the 5-step wizard (Temario · Estándar · Investigación · Revisar · Tiempo), the exam page (Hoy, Tu nivel, Plan · próximos 14 días, Temario, Simulacro in the last 7 days); Inicio «Hoy para tu examen»; Settings → Exámenes; exam notices in the bell; an exam session's batch end returns to the exam or opens the next batch.
