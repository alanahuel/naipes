# Knowledge folder (Obsidian or any folder) and local Linux install

Naipes additions (2026-11-01; generalized for publication 2026-11-03; any folder, not just Obsidian, 2026-11-04). Not part of upstream LearnHarness.

## Desktop app on Linux

`bash scripts/install-linux.sh` builds this checkout into an AppImage and installs it for the current user:

| What | Where |
|---|---|
| AppImage | `~/.local/opt/Naipes/Naipes.AppImage` |
| Launcher | `~/.local/share/applications/naipes.desktop` (`StartupWMClass=naipes`) |
| Icon | `~/.local/share/icons/hicolor/512x512/apps/naipes.png` |
| Data | `~/.config/Naipes/data/` (Electron `userData`; copied once from `~/.config/LearnHarness` on first launch) |
| Keys | `~/.config/Naipes/auth.json` (0600) |
| Shell log | `~/.config/Naipes/logs/main.log` |

The build passes `-c.extraMetadata.npLocalBuild=true`. `electron/main.cjs` reads that flag from the packaged `package.json`: a local build never starts the GitHub updater, so a published release can never replace a build that carries uncommitted or unreleased changes. Instead it only *looks*: at startup, every 24 hours and from **Check for Updates…** / Settings (same automatic-updates toggle), it asks GitHub's `releases/latest` and, when a newer version exists, says so — Settings shows it with a link to the release page, the bell gets a notice, and one desktop notification fires per version (`electron/local-update-check.cjs`; the last announced version persists in `userData/local-update.json`). Nothing is downloaded or installed. To update, commit or pull, then run the script again. `--no-build` reinstalls the last `dist/` AppImage.

## Settings → Connections → Knowledge folder

Any folder of Markdown notes works — an Obsidian vault or a plain folder. One switch turns on both directions. Settings (section `obsidian` in `settings.json`; the key kept its historical name, and so did `vaultPath`, `src/server/vault.ts` and `/api/vault`):

```json
{ "enabled": true, "vaultPath": "/home/me/Notes", "folders": ["Areas/Mathematics"], "obsidianFormat": false }
```

**Obsidian format** (`obsidianFormat`, owner 2026-11-04) picks the link style of every note the app writes: on = `[[path|label]]` wikilinks, off = relative Markdown links (`[Límite](../Conceptos/L%C3%ADmite.md)`, every segment URL-encoded, parentheses included). `aliases:` is written in both modes. When the field is absent it is derived (`resolveObsidianFormat`): ON if a `vaultPath` was already saved (installs from before the switch keep their wikilinks), OFF otherwise. `PUT /api/settings/obsidian` pins the derived value into the record on the first write that lacks it, so a fresh install stays OFF after it chooses a folder. Changing it regenerates every app note; summary notes keep the model's prose and only get their «Conceptos» / «Transcripción» link lists rebuilt (`refreshSummaries`, no model call).

In this document "vault" means the chosen folder.

There is no default folder: while `vaultPath` is empty the sync stays idle and the section asks you to choose the vault folder. Folders start unchecked. The section shows how many files the selection holds, because every new or changed file costs at least one extraction run.

## Vault → graph (`src/server/vault.ts`)

- **Start:** `GET /api/events` (opened by every app window on load) calls `startVaultSync()`, which runs once per server process and never under tests. The first sync waits for `refreshConnectionCatalog()`. Until it finishes, the Claude Code, ChatGPT and subscription models are unknown, and every note would fail with `catalog has no model`. `instrumentation.ts` is not used because its file trace ignores `outputFileTracingExcludes` and would ship `data/`. The sync rereads its settings after every `PUT /api/settings/obsidian`.
- **Reconcile:** scans the selected folders and compares each note's sha256 with `data/vault/state.json`. Unchanged notes cost nothing.
- **Live:** `fs.watch` (recursive) on the vault root; a note is processed after 30 s without changes. Up to 3 notes are processed at once.
- **Moves (phase 3, 2026-11-05):** a known note whose content shows up at a new, untracked path while its old path is gone is RE-KEYED, not re-extracted — whichever of the two watcher events comes first (`processNote`: the new path finds the vanished entry with the same hash; the deleted path hashes only untracked files looking for its copy). The state entry keeps its original source id and the source record's `filePath` (and so its area) follows. A moved note that later changes has that original source's contribution replaced.
- **Clean replace:** a note maps to the notes source `notesSourceId(<vault-relative path>)` (or, after a move, the id it kept). That is the same id the importer derives from a file path. Before re-extraction, its contribution leaves the graph through `deleteSourceTraces` (`deleteChatTraces(…, "delete-nodes")` plus `graphStore.deleteSource`). Concepts shared with other sources survive. A deleted note only has its contribution removed.
- **Legacy imports:** a manual import whose recorded file name matches a newly synced note's base name is replaced the first time that note syncs. It is removed only after the new extraction succeeds, so a failed run keeps it.
- **Failed notes (owner, 2026-11-09):** a note whose import fails is not recorded in `state.notes`, so it used to be retried on every start. When EVERY failed chunk failed because the model never submitted findings (`NotesImportError.modelOnly`; the message `EXTRACTOR_NEVER_SUBMITTED`, e.g. a model refusing pentesting write-ups), the note is PARKED: `state.failed[path] = { hash, at, error }`. Reconcile and the watcher skip it while its content keeps that hash; editing it tries again; a move carries the entry; deleting it drops the entry. Network, quota, key, configuration and cancellation failures never park and retry on the next start as before. Settings → Knowledge folder lists the parked notes under **No se pudieron leer** with **Reintentar** (`POST /api/vault/failed { path }`; `GET` lists them).
- **Bell:** every extraction run over one source (a chat or a note) emits `extraction-ended { source, title, kind, outcome: "ok" | "failed" }`; a partial run is `failed`, a cancelled run or a gate refusal (no models, no key) emits nothing. The bell coalesces them into one notice per outcome: «Pasé a tu grafo…» or, in amber, «No pude pasar a tu grafo…» (a note links to Settings → Connections, a chat to the chat).
- **Ignored:** dotfiles and dot-folders (`.obsidian`, `.trash`), files that are not `.md`, `.txt`, `.pdf`, `.docx` or `.epub`, and the output folder. Deselecting a folder stops reading it but removes nothing.
- **Language:** the extraction prompt (`EXTRACTION_CORE`) writes ideas in the language of their source.

## Documents: PDF, epub, docx, txt (phase 2, owner 2026-11-04)

`src/server/doc-text.ts` turns a document into ordered **segments** (`src/core/doc-chunks.ts`); the notes pipeline extracts them like a note. The hash in `state.json` is over the file's bytes (identical to the old text hash for UTF-8 Markdown).

| Format | Conversion |
|---|---|
| PDF | `pdfjs-dist`, one segment per page (`hasEOL` line breaks). Pages with under 10 characters are scans: with a `tesseract` binary installed they are rendered (pdfjs + `@napi-rs/canvas`, 200 dpi) and OCR'd locally with `spa`/`eng` (whichever is installed); OCR only replaces the text when it reads more. Without tesseract they are skipped and the bell says so (`vault-notice` kind `ocr-missing`). |
| docx | `fflate` opens the zip; `word/document.xml` → Markdown with linkedom (heading styles `Heading1`/`Título1`/`Title` → `#`, numbered/bulleted → `- `, tables as `| a | b |` rows). |
| epub | `fflate` + the OPF spine order; each chapter's XHTML → Markdown with turndown; chapter title = first heading, else `<title>`, else the file name. |
| txt | verbatim. |

- **Cache:** `data/vault/text/<sha256><ext>.json`. A cached PDF whose OCR was unavailable is converted again once tesseract exists.
- **Chunks and location:** `chunkSegments` packs segments under `graph.extractionChunkTokens` without crossing a page/chapter (an over-budget page splits by line). Each chunk's label — `p. 7`, `pp. 45–52`, `cap. «Título»` — is stamped by `mergeFindings` on the provenance of every idea that chunk creates or touches (`ProvenancePoint.loc`). The extractor prompt is unchanged.
- **Big documents:** when the estimate (`estimateRuns` = number of chunks) exceeds `obsidian.confirmAboveRuns` (factory **6** ≈ 24k tokens ≈ 50 pages), the file is not extracted and keeps any previous contribution. `state.pending[path]` records the hash and estimate; the bell gets a `vault-notice` (kind `pending`) with **Leer** / **Ahora no**, and Settings → Knowledge folder lists every waiting file. `POST /api/vault/pending { path, decision }`: `read` stores `state.confirmed[path] = hash` and extracts that exact content; `later` sets `deferred` (no new notice until the file changes).
- **Concept notes:** a document source is written once per location, `[libro.pdf, pp. 45–52](…/libro.pdf#page=45)` (or `[[…/libro.pdf#page=45|…]]` in Obsidian format, which opens that page).
- **Conocimiento:** the idea card shows `libro.pdf, pp. 45–52`; in the desktop app clicking it opens the file with the system viewer through `np:open-source` (`electron/knowledge-source.cjs`: only a regular readable file inside the folder, realpath-checked). Whether the viewer jumps to the page depends on it.
- **Manual import** (`POST /api/graph/import`) accepts the same formats. A document over the threshold returns `outcome: "needs_confirmation"` with `runs`/`pages`; the import row shows **Leer** / **Ahora no**, and «Leer» resends that file with a `confirm` field. Manual imports show the location but cannot be opened (the file is not in the folder).

Tests: `tests/documents.test.ts`, `tests/documents-import-route.test.ts`, the document cases in `tests/vault.test.ts` and `tests/graph.test.ts`.

## Inbox and folder suggestions (phase 3, owner 2026-11-05)

- **Settings:** `obsidian.suggestFolders` («Sugerir dónde guardar», OFF by default) and `obsidian.inboxFolder` (factory `Bandeja`; must not overlap the output folder — 400). While on, the inbox is created on reconfigure and is always read, selected or not.
- **The rule** (`src/core/inbox.ts` `rankFolders`, graph-only, no model): an inbox note's idea connects to folder F when (a) the same idea has provenance from a note in F, or (b) a chain joins it to an idea of a note in F. Only folder notes outside the inbox count (not sessions, manual imports or the note itself), and only destination folders. Distinct ideas are counted per folder; the top folder is suggested with **≥ 2** ideas, **more than half** of the per-folder sum and no tie. The next 2 are alternatives.
- **Destinations:** the folders that are read and their subfolders, never the inbox or the output folder.
- **API** `GET /api/vault/inbox` → items with `status` (`suggested`, `none`, `pending` for «Leer», `extracting`, `waiting`), `suggestion {folder, count, total}`, `alternatives`, plus `destinations`. `POST { path, action: "move", folder }` renames the file (name clash → ` (2)`, ` (3)`…) and re-keys at once — no extraction. `POST { path, action: "dismiss" }` stores `state.dismissed[path] = {hash, folder}`: hidden while the content and the winning folder stay the same.
- **UI:** a floating «Bandeja (N)» card bottom-left in Conocimiento (`components/inbox-card.tsx`) with «Mover» / «Descartar» / «Elegir otra…» (alternatives first, then every destination). The bell gets ONE coalesced notice (`vault-notice` kind `suggestions`, fixed id `vault-suggestions`, replaced by newer counts) when a new suggestion appears; `state.suggested` remembers what was announced. Suggestions are recomputed after every concept export (graph change).

Tests: `tests/inbox.test.ts` (the rule) and the move/inbox cases in `tests/vault.test.ts`.

## App → vault

The output folder (default `Naipes/`, configurable) has these subfolders:

| Subfolder | Content | Updated |
|---|---|---|
| `Transcripciones/` | each teaching session (`sessionMarkdown`) and the concepts extracted from it | after every turn |
| `Prácticas/` | each practice session: problems, answers and verdicts | after every turn |
| `Conceptos/` | one note per proposition: statement, aliases (also the `aliases` frontmatter key), «Se sigue de», «Permite concluir», sources | when the graph changes |
| `Sesiones/` | model-written prose summary | **Summarize to your folder** in the session menu (`POST /api/chats/:id/vault-summary`; one call on the extractor's model) |

Note format (`src/core/vault-notes.ts`):

- **Frontmatter:** the app rewrites its own keys (`tipo`, `estado`, …); any key you add is kept.
- **App zone:** everything between `<!-- naipes:inicio -->` and `<!-- naipes:fin -->` is regenerated. Text outside the markers (`## Mis notas`) is never touched.
- **Your note:** removing a marker makes the note yours, and the app stops writing it.
- **Deleted sessions and concepts:** a session deleted in the app gets `estado: eliminada`; a concept that leaves the graph gets `estado: eliminado`. Neither note is deleted. A concept re-extracted under the same name reuses its old note, including your zone.

Tests: `tests/vault.test.ts`.
