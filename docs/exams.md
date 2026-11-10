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

A miss drops one mode; two misses in a row at Recordar or below → «por enseñar»; in the placement test a miss with no level yet → «por enseñar». A later teach event clears it. Every practice submission carries the learner's 0–100 confidence (the practice dock's slider — never pre-filled since 2026-11-09: it must be picked before sending and any change to the answer empties it); a solve below the threshold also grades **Hard** in FSRS. Mock exams never grade.

## Lifecycle (v2, owner 2026-11-06: the syllabus leads)

1. **Temario** — title, date, the guidelines (text, or an md/txt/pdf/docx/epub whose text seeds them), **Materiales** (research sources only — files stored in `data/exams/<id>/materials/`, page photos OCR'd, web links; never syllabus, never the graph), **Carpetas** (a tree of every knowledge-folder folder holding notes, read or not — «(N ideas)» / «(N notas · sin leer)»; tri-state at any depth: a click sets a subtree, any descendant can be unchecked, a partial folder keeps its loose notes; stored as `folders` recursive + `directFolders` loose notes only) and an optional **Contexto** (type, exam/subject, school or body, location, sitting — prefilled from the date's year — goal). Creating it makes a draft. A draft can be deleted from its «···» menu.
2. **Estándar** — chosen before the research: it sets the research depth. «Investigar →»: unread folders in the scope get a notice («Se añadirán a tu conocimiento…»); confirmed, they are added to Settings → Knowledge (a partial folder with loose notes is added whole — the connection reads whole folders) and read first (mapping state `reading`, «Leyendo tus carpetas… x de N»; failures listed later).
3. **Investigación** — **official guide first** (owner 2026-11-06, see below): the guide finder looks for the exam's official guide (`guide`), then the `syllabusMapper` (strong slot) builds blocks → points from it, adjusted by the guidelines (`running`), then the **exam researcher** (`src/agent/subagents/exam-researcher.ts`, owner-approved prompt) runs block by block (`researching`) producing each point's **target ideas** (≤ 12, depth by preset; «Personalizar» follows its mode): from the materials (`read_material`), the web (official guide for the sitting first, recent past papers; old material flagged `outdated`, each source with its year) and the model's knowledge, each linked to the candidate graph ideas that express it. Web search: Claude Code's own WebSearch when connected (`src/server/exam-research-io.ts` — one `claude -p` call per query, only WebSearch allowed, the cheap slot's model), else Tavily/Brave, else none («Sin búsqueda web»). A failed block keeps what was done; «Reintentar» resumes.
4. **Revisar** — the guide line («Guía oficial: … (año)» / «Sin fuente oficial», the scope note, «Tus directrices cambian la guía:»), blocks («Entra en esta prueba») → points (origin badge; «Ampliación (N)» with «Ascender a punto extra») → target ideas with source and links; edit, remove, add, unlink; «Volver a investigar este punto / todo».
5. **Tiempo** → **Active**. Target ideas live in the exam, not the graph: they enter it only when taught. The exam's ideas join Repaso as before (exempt from the cap, due earlier for the date, a final review in the last days).
6. **Archived** — after the date (final coverage frozen) or by hand.

Exams made before v2 keep their point links; the exam page offers «Investigar temario» to add target ideas to the points without them.

## Official guide first (owner 2026-11-06)

Before, a syllabus with no guidelines text was outlined from the names of the folder ideas, so the blocks were whatever the notes held (rules, study tips, unrelated literature). Now the official guide leads and the graph only enriches:

- **Guide finder** (`src/agent/subagents/exam-guide-finder.ts`, strong slot, owner-approved prompt): the learner's materials first, then the web (same search as the research); copies the guide's contents in its own words (blocks → points; a block that lists nothing is split by the model, those points `fromGuide: false` → origin `model`), scoped to the test on the exam date (`inSitting`, `scopeNote` «Entra en febrero: temas 1–6»), subject matter only. Runs for every context type but **Personal** (or an empty context) — `guideWanted`. Mapping state `guide` («Buscando la guía oficial…»).
- **Not found** → state `needs_guide`, `guide.state = missing` with the reason: «Pegar texto» (saved as the material «Guía (pegada)»), «Adjuntar archivo», «Añadir enlace» (then searches again), «Buscar de nuevo», «Seguir sin guía» (`guide.state = none`: the guidelines, or the model's proposal from the context, marked «Sin fuente oficial»). `POST /api/exams/[id]/guide { action: retry | skip }`.
- **Mapper** (owner-approved prompt): keeps the guide's blocks/points (origin `official`); the guidelines restrict, remove, add (origin `user`) or bring an out-of-sitting block in — contradictions listed in `guide.conflicts`. No rules/tutor kinds any more (manual instructions still work). Candidates only **link** (`nodeIds`) or go to the closest point's **ampliación** (`extension`); unrelated ones stay out.
- **Out of this sitting** (`SyllabusBlock.excluded`): kept, greyed in Revisar, not studied nor researched (`studyPoints`/`instructionPoints` skip them); «Entra en esta prueba» brings it in.
- **Origin** (`SyllabusPoint.origin`): «Guía oficial» · «Tu texto» · «Propuesto por el modelo» · «Punto extra».
- **«Ascender a punto extra»** (`promoteExtension`, `POST /api/exams/[id]/promote`): an ampliación idea becomes its own counted point (origin `extra`) with one target from the idea («De tus notas», source kind `notes`).
- **«Contrastar con la guía»** (exam page, `POST/PUT/DELETE /api/exams/[id]/contrast`, `exam-contrast.ts`): finds the guide, the model says which current points cover each official point; «Faltan en tu temario (N)» (add, in-sitting ones pre-checked) and «No están en la guía (N)» («Pasar a ampliación» → its ideas to the closest official point's ampliación, or «Mantener como punto extra»). Nothing changes until «Aplicar»; added points are researched right after.
- The research task carries `GUIDE: título (año) enlace` and reads it first.

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

## «Conocimientos previos» (owner 2026-11-09)

Knowledge the syllabus takes for granted (earlier-stage foundations it does not teach itself). Stored in `ExamRecord.prerequisites`: statement, source, graph links (`nodeIds`), what rests on it (`blocks`: point ids or shallower prerequisite ids), `origin` (research · diagnosis · user), `depth` (1 = right under the syllabus, at most 3) and a shared `key`.

- **Not counted** in the coverage. Its own bar is **Componer** with the exam's recall, whatever the preset (`PREREQUISITE_LEVEL`; an idea's `goal`).
- **Blocking**: a point (or shallower prerequisite) rests on it until it is **unlocked** — taught, or shown known, and solved at least at Recordar (`PrerequisiteStatus.unlocked`). A blocked point is not taught and its ideas get **no mode practice** (dated review goes on): `PointStatus.blockedBy`, `IdeaStatus.blocked`.
- **Plan**: the placement test asks every prerequisite first (`pendingIdeas`/`pendingPoints` lead with them); the day's teach block takes the deepest unblocked one first, then the one most points rest on (`nextPrerequisite`); one session each (`ChatExamLink.prerequisiteId`, prompts `teach-prerequisite.md` / `consolidate-prerequisite.md` — a short one when shown known but not in the graph). `examWork` adds the prerequisites under the points chosen for the coverage, once.
- **Shared through the graph**: ideas born in its teach sessions belong to it; same-key prerequisites in other exams carry each other's ideas (`sharePrerequisiteIdeas`, also in the Repaso deadlines) — taught once, reviewed once.
- **Found by the research**: after a draft's whole research, the **prerequisite finder** (`exam-prerequisites.ts`, strong slot, `search_ideas` over the graph, owner-approved prompt) lists each block's level-1 prerequisites, reusing EXISTING ones (this exam's and other exams'); mapping state `prerequisites`; reviewed in Revisar («Conocimientos previos»: edit, remove, add, change the topics that need it).
- **Diagnosis in the placement test** (`placement-prerequisites*.md`): after a miss or «no lo sé», 1–2 short recall problems on what it rests on; a newly detected base is registered with the practice tool `note_prerequisite` (`noteDiagnosedPrerequisite`: one level under the missed item, at most 3; the same statement reuses the existing one).
- **Active exams** (retroactive): «Detectar conocimientos previos» (`POST/PUT/DELETE /api/exams/[id]/prerequisites`) runs the finder with the placement test's misses (`placementMisses`) as evidence; the proposal waits in `prerequisiteSearch` («Lo sugiere: “…”») until «Aplicar» (checked items) or «Descartar». New unlinked ones become placement questions.
- Exam page: section «Conocimientos previos» (state, origin, «Lo necesitan» / «Base de», «Bloquea N temas», «Editar»), «Bloqueado por: …» under points.

## The plan

- **Work** (`examWork`): the exhaustive placement test (climbs to the standard's mode), teaching «falta» points (full, or a short «afianzado» when the placement showed the learner knows it), consolidation for «por enseñar» ideas, mode practice, and reviews until the exam. Only the points needed for the coverage count: already meeting first, then prioritized blocks, then the cheapest.
- **Durations**: settings defaults (teach 25, afianzado 10, problem 6, review idea 2 minutes) until three measured samples of the learner's active time exist (gaps capped at 5 minutes).
- **Budget** (`planBudget`): one global set of minutes per weekday for all exams. Review minutes are spread over the study days left; the rest goes earliest-deadline-first.
- **Today** (`todayBlocks`): dated review → placement test (while pending) or mode practice → teach one point. Each block is its own session.
- **«Calendario»** (owner 2026-11-10, `docs/calendar.md`): each date's budget is the calendar's (overrides, classes that consume time, pinned sittings, Repaso and «Preparar clase» taken out); the exam page's «Hoy» and «Plan» show the calendar filtered to the exam; a point a class confirmed is a short afianzado (`classCovered`), one a future class plans is not taught before it.
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
| `POST/DELETE /api/exams/[id]/materials` | add a material (multipart file, `{ url }` or pasted `{ text, name }`) / remove one |
| `POST /api/exams/[id]/guide` | while the guide is missing: `{ action: "retry" }` / `{ action: "skip" }` |
| `POST/PUT/DELETE /api/exams/[id]/contrast` | «Contrastar con la guía»: start / apply `{ add, extras }` / discard |
| `POST /api/exams/[id]/promote` | «Ascender a punto extra» `{ pointId, ideaId }` |
| `POST /api/exams/[id]/research` | resume (`{}`), the pending type changes (`{ mode: "pending" }`), redo all (`{ mode: "all" }`) or one point (`{ pointId }`) |
| `POST /api/exams/[id]/kind` | change a block's or point's type (`{ blockId, pointId?, kind }`); changed points wait as pending |
| `POST /api/exams/[id]/classify` | «Clasificar temario»: the model types blocks and points, changed ones are researched again |
| `GET/PUT/DELETE /api/exams/[id]` | detail with the derived plan / edit, activate, archive, real grade / delete |
| `POST /api/exams/[id]/map` | start read → guide → outline → research (202; 503 without a strong model) |
| `POST /api/exams/[id]/preview` | the wizard's what-if forecast |
| `POST/PUT/DELETE /api/exams/[id]/prerequisites` | «Detectar conocimientos previos»: run the finder / apply `{ accept }` / discard |
| `POST /api/exams/[id]/sessions` | start a block: placement, practice, review, teach, mock, deepen |
| `POST /api/exams/syllabus-file` | a syllabus file → text |

## Interface

The 5th tab **Exámenes** (`components/exams.tsx`): the list, the 5-step wizard (Temario · Estándar · Investigación · Revisar · Tiempo), the exam page; Inicio «Hoy para tu examen»; Settings → Exámenes; exam notices in the bell; an exam session's batch end returns to the exam or opens the next batch.

### The exam page's tabs (owner 2026-11-09)

No more one long scroll. **Hoy** (the ordered blocks + «Empezar») stays above the tabs — «Resultado» instead once archived — and below them the same five tabs for active and archived exams (`components/ui/tabs.tsx`, Radix Tabs: ←/→, Home/End):

- **Resumen** — Tu nivel (with the «no llega» options), Plan · próximos 14 días, Simulacro in the last 7 days. Archived: the level only.
- **Temario** · **Conocimientos previos** — the sections as before.
- **Asignatura** · **Tutor** — always shown, titled in full inside. Empty: «Todavía no hay instrucciones.» Both fill from the tab: «Añadir apartado» (a hand-written point, `targets: []`, no research — appended to the first live block of that type, or a new block named after it) and «Traer del temario» (a syllabus point changes type and waits for «Investigar cambios», which the tab also shows).

The open tab is in the URL: `?tab=temario|previos|asignatura|tutor`, none = Resumen, switched with `history.replaceState` (no server round-trip). «Priorizar» opens Temario with the blocks highlighted. A tab you are not on carries a dot (sr-only «hay algo pendiente») when it wants you or has work running — `examTabAlerts` in `src/core/exam-tabs.ts`: Resumen = «no llega»; Temario = research/outline running, a contrast, unresearched points or a pending syllabus point; Conocimientos previos = a search running or a proposal to review; Asignatura/Tutor = one of their points pending (or being researched). Archived exams carry none.

**Pages** (owner 2026-11-09, v0.19.1): Temario's blocks, Conocimientos previos and the Asignatura / Tutor sections show 10 per page (`EXAM_PAGE_SIZE`, `pageSlice`), with «‹ Anterior · 2 de 4 · Siguiente ›» below (`components/ui/pager.tsx`) — no pager up to 10. Each tab keeps its own page in the URL (`?tab=temario&p-temario=3`, page 1 = no param), so switching tabs, coming back from a session or reloading keeps it; a list that shrank lands on its last page; «Añadir apartado» lands on the page of the new section.

The tab row hides its scrollbar with an inline `scrollbarWidth: none` (the app-wide thin scrollbar in `globals.css` is unlayered and beats utility classes) and draws the underline as an inset shadow, so nothing overflows vertically.
