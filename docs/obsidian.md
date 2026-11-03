# Obsidian connection and local Linux install

Local modification (owner, 2026-11-01). Not part of the upstream release.

## Desktop app on Linux

`bash scripts/install-linux.sh` builds this checkout into an AppImage and installs it for the current user:

| What | Where |
|---|---|
| AppImage | `~/.local/opt/LearnHarness/LearnHarness.AppImage` |
| Launcher | `~/.local/share/applications/learnharness.desktop` (`StartupWMClass=learnharness`) |
| Icon | `~/.local/share/icons/hicolor/512x512/apps/learnharness.png` |
| Data | `~/.config/LearnHarness/data/` (Electron `userData`) |
| Keys | `~/.config/LearnHarness/auth.json` (0600) |
| Shell log | `~/.config/LearnHarness/logs/main.log` |

The build passes `-c.extraMetadata.lhLocalBuild=true`. `electron/main.cjs` reads that flag from the packaged `package.json`: a local build never starts the GitHub updater and hides **Check for Updates…**, so an upstream release can never replace a build that carries local changes. To update, commit or pull, then run the script again. `--no-build` reinstalls the last `dist/` AppImage.

## Settings → Obsidian

One switch turns on both directions. Settings (section `obsidian` in `settings.json`):

```json
{ "enabled": true, "vaultPath": "/home/me/Obsidian/MyVault", "folders": ["Areas/Mathematics"] }
```

There is no default vault: while `vaultPath` is empty the sync stays idle and the section asks you to choose the vault folder. Folders start unchecked. The section shows how many notes the selection holds, because every new or changed note costs one extraction run.

## Vault → graph (`src/server/vault.ts`)

- **Start:** `GET /api/events` (opened by every app window on load) calls `startVaultSync()`, which runs once per server process and never under tests. The first sync waits for `refreshConnectionCatalog()`. Until it finishes, the Claude Code, ChatGPT and subscription models are unknown, and every note would fail with `catalog has no model`. `instrumentation.ts` is not used because its file trace ignores `outputFileTracingExcludes` and would ship `data/`. The sync rereads its settings after every `PUT /api/settings/obsidian`.
- **Reconcile:** scans the selected folders and compares each note's sha256 with `data/vault/state.json`. Unchanged notes cost nothing.
- **Live:** `fs.watch` (recursive) on the vault root; a note is processed after 30 s without changes. Up to 3 notes are processed at once.
- **Clean replace:** a note maps to the notes source `notesSourceId(<vault-relative path>)`. That is the same id the importer derives from a file path. Before re-extraction, its contribution leaves the graph through `deleteSourceTraces` (`deleteChatTraces(…, "delete-nodes")` plus `graphStore.deleteSource`). Concepts shared with other sources survive. A deleted note only has its contribution removed. A rename counts as a delete plus an add.
- **Legacy imports:** a manual import whose recorded file name matches a newly synced note's base name is replaced the first time that note syncs. It is removed only after the new extraction succeeds, so a failed run keeps it.
- **Ignored:** dotfiles and dot-folders (`.obsidian`, `.trash`), non-`.md` files, and the output folder. Deselecting a folder stops reading it but removes nothing.
- **Language:** the extraction prompt (`EXTRACTION_CORE`) writes ideas in the language of their source.

## App → vault

The output folder is `003 - 📋 RECURSOS/007 - LEARNHARNESS 🎓/`, with these subfolders:

| Subfolder | Content | Updated |
|---|---|---|
| `Transcripciones/` | each teaching session (`sessionMarkdown`) and the concepts extracted from it | after every turn |
| `Prácticas/` | each practice session: problems, answers and verdicts | after every turn |
| `Conceptos/` | one note per proposition: statement, aliases (also Obsidian `aliases`), «Se sigue de», «Permite concluir», sources | when the graph changes |
| `Sesiones/` | model-written prose summary | **Summarize to Obsidian** in the session menu (`POST /api/chats/:id/vault-summary`; one call on the extractor's model) |

Note format (`src/core/vault-notes.ts`):

- **Frontmatter:** the app rewrites its own keys (`tipo`, `estado`, …); any key you add is kept.
- **App zone:** everything between `<!-- learnharness:inicio -->` and `<!-- learnharness:fin -->` is regenerated. Text outside the markers (`## Mis notas`) is never touched.
- **Your note:** removing a marker makes the note yours, and the app stops writing it.
- **Deleted sessions and concepts:** a session deleted in the app gets `estado: eliminada`; a concept that leaves the graph gets `estado: eliminado`. Neither note is deleted. A concept re-extracted under the same name reuses its old note, including your zone.

Tests: `tests/vault.test.ts`.
