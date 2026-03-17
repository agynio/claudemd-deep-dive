# How Claude Code Reads CLAUDE.md Files — Experiment

Claude Code supports `CLAUDE.md` files at multiple levels. Global and project-root
files are simple — loaded once at session start, always in context. Subdirectory files
are different: the docs say they load *"on demand as Claude navigates your codebase"*
but explain nothing about the actual mechanism.

We had questions that mattered for building agents:

- What exactly triggers the load — any tool, or a specific one?
- Does it re-inject on every file read, or is there deduplication?
- Where does the content go — system prompt or messages?
- What survives a session resume?
- Does repeated injection blow up token costs?

To answer these we put an intercepting HTTP proxy between Claude Code and the
Anthropic API and traced every `/v1/messages` call. Full write-up: **[REPORT.md](./REPORT.md)**

---

## Key Findings

| Question | Answer |
|----------|--------|
| What triggers subdir CLAUDE.md? | `Read` tool only — not Bash, Glob, or Write |
| Where does it appear? | Concatenated into the tool result text — not the system prompt, not a separate message |
| Does system prompt grow? | Never — stays constant regardless of how many subdirs load |
| Re-injected on every Read? | No — once per subprocess per directory (`readFileState` Map) |
| Visible after injection? | Yes — sticky in message history for all subsequent turns |
| Parallel reads, same dir? | One injection total for the whole batch |
| Persisted to disk? | Stripped before writing — disk session is always clean |
| Session resume? | `readFileState` resets → fresh injection on first Read |
| Token cost? | Near-zero — prompt caching absorbs it |

---

## Repository Structure

### Experiment scripts

| File | Description |
|------|-------------|
| `src/experiment.ts` | **Experiment 1** — 9 scenarios covering first Read, same-session re-read, new session, multiple subdirs, Write-only, Glob-only, Bash-only, and resumed session. Outputs `results.json`. |
| `src/experiment2.ts` | **Experiment 2** — edge cases: same file read twice, glob+read ordering, compaction setup, bash cat, write-only. Outputs `results2.json`. |
| `src/experiment3.ts` | **Experiment 3** — token counting via proxy interception. Runs alongside `proxy.ts` to measure system prompt size, message count, and token cost per call. Outputs `results3.json`. |
| `src/proxy.ts` | Intercepting HTTP proxy on port 9877. Strips `accept-encoding` so the API returns uncompressed SSE. Logs system prompt size, CLAUDE.md marker counts, and token counts for every `/v1/messages` call. |
| `src/extract-source.ts` | Extracts the relevant source snippets from `cli.js` (the injection chain: `lJ7`, `_B9`, call site, `readFileState`, hook schema) and saves them to `results-source.json`. |

### Results / evidence

| File | Description |
|------|-------------|
| `results.json` | Hook event log from experiment 1. Each entry is a `SESSION_START`, `TOOL_USE`, `INSTRUCTIONS_LOADED`, or `RESPONSE_MARKERS` event. Primary evidence for trigger and dedup findings. |
| `results2.json` | Hook event log from experiment 2. Evidence for edge cases: glob does not trigger, write does not trigger, same-dir dedup holds. |
| `results3.json` | Proxy metrics + hook events from experiment 3. Shows `sys` (system prompt bytes) constant at 154ch while `in` (non-cached input tokens) stays near 1. |
| `proxy.bodies.jsonl` | Full raw `/v1/messages` request bodies for every API call during experiment 3, one JSON object per line. The key proof: `msg[2]` shows the `<system-reminder>` block concatenated directly onto the file content in the `tool_result`. |
| `results-source.json` | Extracted source snippets from `@anthropic-ai/claude-agent-sdk/cli.js` with byte offsets. Shows `lJ7` (wraps content in `<system-reminder>`), `_B9` (retrieves stored CLAUDE.md and calls `lJ7`), the call site where `_B9(A)` is prepended to the file content, `readFileState` dedup Map, and the `InstructionsLoaded` hook schema. |

### Test environment

| Path | Description |
|------|-------------|
| `test-env/CLAUDE.md` | Root-level instructions, loaded at `session_start`. Contains `ROOT_LOADED` marker. |
| `test-env/src/CLAUDE.md` | Subdir instructions for `src/`. Contains `SRC_DIR_LOADED` marker. Injected on first `Read` into `src/`. |
| `test-env/tests/CLAUDE.md` | Subdir instructions for `tests/`. Contains `TESTS_DIR_LOADED` marker. |
| `test-env/docs/CLAUDE.md` | Subdir instructions for `docs/`. Contains `DOCS_DIR_LOADED` marker. |
| `test-env/src/a.md`, `b.md` | Used in chained-read experiment: `src/CLAUDE.md` instructs the agent to also read `b.md` after reading `a.md`, testing whether a CLAUDE.md-triggered read itself re-fires injection. |

### Report

| File | Description |
|------|-------------|
| `REPORT.md` | Full technical report. Covers background (3 CLAUDE.md levels), motivation, all 7 findings with evidence references, summary table, and architecture diagram of the injection flow. |

---

## Setup

Requires Node.js 18+ and an Anthropic API key. If you already use Claude Code
interactively, your key is already set — the experiments spawn Claude Code
subprocesses that inherit `ANTHROPIC_API_KEY` from the environment.

```bash
npm install
```

---

## Running the Experiments

```bash
npm run exp1   # Basic trigger/session scenarios → results.json
npm run exp2   # Edge cases (glob, write, compaction) → results2.json
npm run exp3   # Proxy token counting → results3.json
```

Experiment 3 must run with `CLAUDECODE` unset to allow nested Claude Code sessions —
the `npm run exp3` script handles this automatically (`CLAUDECODE= npx tsx ...`).

Full request bodies are written to `proxy.bodies.jsonl` for deep inspection
of raw API payloads — this file is committed as part of the evidence trail.

---

## How It Works

When Claude Code executes a `Read` tool call on a file in `src/`:

1. Checks `query.readFileState` — an in-memory Map on the session object
2. If `src/CLAUDE.md` not yet loaded this subprocess:
   - Appends CLAUDE.md content as `<system-reminder>` **directly to the end of the
     tool result text** (not the system prompt, not a new message)
   - Marks it in `readFileState` — no further injection this subprocess
   - Fires the `InstructionsLoaded` hook
3. The enriched tool result is sent to the LLM — it sees the file content with
   instructions appended, as if they were part of the file
4. The turn is written to disk with the `<system-reminder>` **stripped** — disk
   session stays clean
5. On resume (new subprocess), `readFileState` is empty → first Read re-injects fresh

The proxy confirms the system prompt never changes (`sys=154ch` constant). The
CLAUDE.md content only ever appears inside the messages array, in the tool result
that triggered the load.

Source-confirmed: see `results-source.json` for extracted `cli.js` snippets —
`lJ7` wraps content in `<system-reminder>`, `_B9` calls it, and the Read tool's
call site prepends `_B9(A)` to the file content string. `readFileState` on the
session object is the deduplication gate.
