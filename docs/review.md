# Spaced review («Repaso»)

Owner design, 2026-11-04. One forgetting curve per graph proposition (FSRS-6 via `ts-fsrs` 5.3.1, pinned), reviewed through practice sessions.

## Where grades come from

Grades are never stored: `src/core/review.ts` derives them from the chat records on every read.

| Source | Rule | Grade |
|---|---|---|
| Teach «check» (last per plan step) | correct, confidence ≥ threshold (70) or absent | Good |
| | correct, confidence below threshold | Hard |
| | wrong / «I don't know» | Again |
| Teach, idea no check covers | seen in the session | Good, at its message time |
| Practice `conclude` with targets | solved, recall | Good |
| | solved, discrimination / composition | Easy |
| | solvedWithHints R1–R2 (or none/R0) | Hard |
| | solvedWithHints R3–R5, surrendered | Again |
| | movedOn, dismissed, untagged problems | — |

Predictions (`questionType: "predict"`) and dismissed answers never count. Only the teach phase maps to steps: each message belongs to the step of the **next** nodeId-tagged quiz call (messages after the last one → the last step). An idea takes the check of every step its provenance points into.

## What is enrolled

Ideas with provenance in a teach session, ideas of activated Obsidian areas (`area:<two folder levels>`), and anything practiced — minus pauses (origin session, origin area, single idea). An idea's group is its first teach session, else its area.

**Shared daily intake** (`review.newPerDay`, 15): history already overdue when review was first computed (`activatedAt`) is released most-forgotten-first, then new area ideas, oldest first. Released lines persist in `review/intake.jsonl`, so the order never reshuffles. Days roll over at 04:00 local; Again schedules another day (no short-term steps); FSRS fuzz is on.

## Files

`data/review/sources.json` (activation, areas, pauses), `intake.jsonl`, `notices.jsonl`. Tunables: settings sections `review` (retention 0.80–0.97, digest/evening times, cap, batch size, confidence threshold) and `desktop` (tray, autostart).

## API

| Route | Purpose |
|---|---|
| `GET /api/review` | summary (due by group, retention, 7/30-day forecast), items, areas, sources |
| `POST /api/review/start` | creates the next review session (≤ batch size, most forgotten first, groups alternating) — `{ id, title, opening, nodeIds }`; 409 when nothing is due |
| `PUT /api/review/sources` | replaces `areas` and/or `paused.{sessions,areas,nodes}` |
| `POST /api/review/notify?kind=digest\|evening` | the desktop shell's minute clock: the server applies the rules, records the notice, emits `review-notice` (bell) and returns localized text |

Review sessions are practice chats with `review: { day }`; the practice agent gets `src/agent/prompts/review-session.md` appended to its system prompt (not an editable prompt segment, and never composed into ordinary practice).

## Notice rules

- **Digest** — from `digestTime` until `eveningTime` (a digest missed while the computer was off goes out at startup), once per review day, only with something due.
- **Evening** — from `eveningTime`, once per day, only with something due and no review session started that day.

## Desktop shell

`electron/review-desktop.cjs` + `main.cjs`: tray (Abrir · Repasar ahora (N) · Salir; click opens the window), closing the window keeps Naipes resident while the tray exists, login autostart with `--hidden` (Linux: our own `~/.config/autostart/naipes.desktop`, marked `X-Naipes-Autostart=true`; Windows/macOS: the login item; packaged builds only). A notification click — or the tray's review item — navigates to `/review` through the allow-listed `np:navigate` channel.
