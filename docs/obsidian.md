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

There is no default folder: while `vaultPath` is empty the sync stays idle and the section asks you to choose the vault folder. Folders start unchecked. The section shows how many notes the selection holds, because every new or changed note costs one extraction run.

## Vault → graph (`src/server/vault.ts`)

- **Start:** `GET /api/events` (opened by every app window on load) calls `startVaultSync()`, which runs once per server process and never under tests. The first sync waits for `refreshConnectionCatalog()`. Until it finishes, the Claude Code, ChatGPT and subscription models are unknown, and every note would fail with `catalog has no model`. `instrumentation.ts` is not used because its file trace ignores `outputFileTracingExcludes` and would ship `data/`. The sync rereads its settings after every `PUT /api/settings/obsidian`.
- **Reconcile:** scans the selected folders and compares each note's sha256 with `data/vault/state.json`. Unchanged notes cost nothing.
- **Live:** `fs.watch` (recursive) on the vault root; a note is processed after 30 s without changes. Up to 3 notes are processed at once.
- **Clean replace:** a note maps to the notes source `notesSourceId(<vault-relative path>)`. That is the same id the importer derives from a file path. Before re-extraction, its contribution leaves the graph through `deleteSourceTraces` (`deleteChatTraces(…, "delete-nodes")` plus `graphStore.deleteSource`). Concepts shared with other sources survive. A deleted note only has its contribution removed. A rename counts as a delete plus an add.
- **Legacy imports:** a manual import whose recorded file name matches a newly synced note's base name is replaced the first time that note syncs. It is removed only after the new extraction succeeds, so a failed run keeps it.
- **Ignored:** dotfiles and dot-folders (`.obsidian`, `.trash`), non-`.md` files, and the output folder. Deselecting a folder stops reading it but removes nothing.
- **Language:** the extraction prompt (`EXTRACTION_CORE`) writes ideas in the language of their source.

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
