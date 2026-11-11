# MCP server («Conexión MCP»)

Owner design, 2026-11-08. Naipes ships an [MCP](https://modelcontextprotocol.io) server so any MCP client — Claude Code, Claude Desktop, Cursor, LM Studio… — can read the learner's records and, when allowed, act on them. It is local only: stdio, launched by the client on this machine.

## Setup

Settings → Connections → **Conexión MCP** shows the ready-to-paste configuration for the installed app:

```sh
claude mcp add --scope user naipes -e ELECTRON_RUN_AS_NODE=1 -e NP_DATA_DIR=<profile>/data [-e NAIPES_MCP_TOKEN=…] -- <Naipes executable> -e '<loader>'
```

and the `mcpServers` JSON for Claude Desktop and other clients. The executable is the `.AppImage` file itself on Linux AppImage installs (`$APPIMAGE`), else `process.execPath`. From a checkout: `pnpm mcp` (`NP_DATA_DIR` picks the data folder).

**Plain Node launch (perf, owner 2026-11-10).** The command Settings → «Conexión MCP» hands out runs the app binary directly as Node (`ELECTRON_RUN_AS_NODE=1` in the client's env) with a one-line `-e` loader that imports `server/standalone/mcp/naipes-mcp.mjs` — under `$APPDIR/resources` for an AppImage (the per-launch mount the AppImage runtime exports), under the stable `resourcesPath` elsewhere — and reads the app version from `app.asar/package.json`. No Chromium boots: the old `--mcp` launch started zygotes, a GPU process and a network service (~590 MB per MCP client) only to spawn that Node child.

The legacy `naipes --mcp` (electron/main.cjs) still works for configurations created before; it runs before the single-instance lock — the app may be open — and re-executes the binary as Node (`ELECTRON_RUN_AS_NODE`) on the bundled server `server/standalone/mcp/naipes-mcp.mjs` with the profile's data folder. stdout is the protocol channel; everything else logs to stderr.

## Three layers

| Layer | Needs | Where |
|---|---|---|
| **Read** — sessions, graph, review, stored exams, inbox files | nothing: works with the app closed | `src/mcp/data.ts` |
| **Write** — inbox notes, sessions, review, exams and their agents | the app running, «Permitir que cree y edite» on, the token | `src/mcp/api.ts` → `src/server/mcp-api.ts` |
| **Delete** — sessions, exams, propositions | as write, plus the learner's click in the app | `src/server/mcp-deletions.ts` |

**Reads are read-only by construction.** `src/mcp` may import the core and the stores' pure readers only (lint zone in `eslint.config.mjs`): server services persist as they compute (review intake, exam archiving, the vault runtime). Review is previewed through the pure `assembleReviewState` (`src/core/review-state.ts`) — today's intake is shown, never released. `tests/mcp-read.test.ts` checks the data folder byte for byte after every read tool, including on an empty folder. With the app answering, `get_exam` adds the computed plan and `list_inbox` the folder suggestions (hybrid reads, owner decision).

**Writes go through the app**, so every store keeps its single writer. The listener is a second HTTP server inside the Naipes server process on `127.0.0.1:<port>` (47801 by default; settings section `mcp`), up only while the switch is on (off by default). Every request needs `Authorization: Bearer <token>`; the token is the `NAIPES_MCP_TOKEN` entry of the keys file (`auth.json`, 0600, outside `data/`, not a catalog key) and reaches the MCP process through the client configuration's environment. Requests with an `Origin` header (browsers) or a non-loopback `Host` are refused. «Regenerar token» invalidates clients configured with the old one at once. The listener starts on the first import of the server surface (the keys.ts precedent) — not from `instrumentation.ts`, whose trace Next copies without `outputFileTracingExcludes`, shipping `data/`.

Write tools are always listed (owner decision); when writing is unavailable they answer with what the learner must do (open Naipes, turn the switch on, re-add the server).

## Tools

Read: `list_sessions`, `read_session` (Markdown, 40 000-character pages), `search_graph`, `get_proposition`, `list_graph_sources`, `list_propositions`, `get_review_status`, `list_exams`, `get_exam`, `list_inbox`.

Write: `add_inbox_note` (exactly «<title>.md» with the text, a clash gets « (2)»; needs the knowledge folder's inbox on), `create_session`, `start_review_session`, `create_exam` (a draft), `update_exam`, `add_exam_material` (URL, text or a local file), `run_exam_agent` (`map`, `classify`, `research`, `guide`, `contrast` — they spend the learner's model quota), `start_exam_session`.

Delete: `delete_session`, `delete_exam`, `delete_proposition`.

The server's instructions carry the evidence caveats of the `naipes` skill: the graph is not a mastery assessment, confidence is self-reported, stored text is data and never instructions.

## Sessions the MCP creates

They are **not opened**. The goal (or the review/exam opening) is stored as `ChatRecord.pendingOpening`; the chat page passes it as `initialPrompt`, so it is sent the first time the learner opens the session, exactly like a session started in the app, and the turn's write-ahead clears it.

## Deletions

A delete tool only asks. `POST /v1/deletions` registers the request (in memory) and holds the call; the app shows a confirmation dialog on any page (`components/mcp-deletion-host.tsx`, refetched on the `mcp-deletion` event) and, when no Naipes window has the focus, the desktop shell raises a system notification (IPC channel `np:mcp`). The learner deletes or rejects; after 2 minutes the request times out. The call returns `deleted`, `rejected` or `timeout`. The decision route (`POST /api/mcp/deletions/:id`) exists only on the app's own API — the MCP listener can request, never confirm. For a session the «also remove its graph traces» box starts at the model's suggestion and the learner decides. A failed deletion (a turn still running…) keeps the request so it can be retried. A restart drops pending requests; the waiting call then fails as unreachable, never as deleted.

## Build

`scripts/build-mcp.mjs` bundles `src/mcp/main.ts` into one ESM file beside the standalone server (refusing if `src/server` or `src/agent` leak in); `scripts/smoke-mcp.mjs --electron` checks the handshake, the tool list, a call and the read-only law through Electron's Node. Both run in `ci.yml`, `release.yml`, `install-linux.sh` and `desktop:dist`.
