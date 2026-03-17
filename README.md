# Claude Code CLAUDE.md On-Demand Loading — Experiment

A series of experiments that trace exactly how Claude Code reads `CLAUDE.md` files in
subdirectories: when they're loaded, where the content goes, how deduplication works,
and what ends up on disk vs in memory.

The core technique is an intercepting HTTP proxy placed between Claude Code and the
Anthropic API, giving full visibility into every `/v1/messages` call.

> Full write-up: [REPORT.md](./REPORT.md)
> Reddit post: [REDDIT_POST.md](./REDDIT_POST.md)

---

## Key Findings

| Question | Answer |
|----------|--------|
| What triggers subdir CLAUDE.md? | `Read` tool only — not Bash, Glob, or Write |
| Where does it appear? | Inside the tool result, as `<system-reminder>` |
| Does it grow the system prompt? | No — system prompt stays constant |
| Re-injected on every Read? | No — once per subprocess per directory |
| Visible after injection? | Yes — stays in message history for all future turns |
| Parallel reads? | One injection for the whole batch |
| Persisted to disk? | Injected content is stripped before writing |
| Resumed sessions? | Fresh injection on first Read (readFileState resets) |
| Token cost? | Near-zero — prompt caching absorbs it |

---

## Repository Structure

```
.
├── src/
│   ├── experiment.ts     # Experiment 1: basic trigger/dedup/session scenarios (9 scenarios)
│   ├── experiment2.ts    # Experiment 2: same-file, glob, write, compaction edge cases
│   ├── experiment3.ts    # Experiment 3: token counting via proxy interception
│   └── proxy.ts          # Intercepting HTTP proxy — logs every /v1/messages call
│
├── test-env/             # Isolated workspace Claude Code runs inside
│   ├── CLAUDE.md         # Root-level instructions (loaded at session_start)
│   ├── src/
│   │   ├── CLAUDE.md     # Subdir instructions (loaded on first Read into src/)
│   │   ├── main.py
│   │   ├── utils.py
│   │   ├── constants.py
│   │   ├── a.md          # Used in chained-read experiment
│   │   └── b.md          # Target of chained read
│   ├── tests/
│   │   ├── CLAUDE.md
│   │   └── test_main.py
│   └── docs/
│       ├── CLAUDE.md
│       └── README.md
│
├── results.json          # Raw hook events from experiment 1
├── results2.json         # Raw hook events from experiment 2
├── results3.json         # Proxy logs + hook events from experiment 3
├── REPORT.md             # Full technical report
└── REDDIT_POST.md        # Reddit post (r/LLMDevs)
```

---

## Setup

Requires Node.js 18+ and an Anthropic API key.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Running the Experiments

### Experiment 1 — Basic trigger and session behaviour

Tests 9 scenarios: first Read, same-session re-read, new session, multiple subdirs,
Write without Read, pure chat, Glob, Bash.

```bash
npx tsx src/experiment.ts
```

Results written to `results.json`.

### Experiment 2 — Edge cases

Same file twice, Glob-then-Read, Read-then-Glob, compaction, Bash cat, Write-only.

```bash
npx tsx src/experiment2.ts
```

Results written to `results2.json`.

### Experiment 3 — Proxy interception + token counting

Starts a local proxy on port 9877, routes all Claude Code traffic through it, and
logs system prompt size, CLAUDE.md marker occurrences in messages, and token counts
for every API call.

**Must unset `CLAUDECODE` to allow nested Claude Code sessions:**

```bash
CLAUDECODE= npx tsx src/experiment3.ts
```

Results written to `results3.json`. Full request bodies (for deep inspection) written
to `proxy.bodies.jsonl` (gitignored — can be large).

---

## How the Proxy Works

`src/proxy.ts` starts a plain HTTP server on `localhost:9877`. Claude Code is pointed
at it via `ANTHROPIC_BASE_URL=http://127.0.0.1:9877`. For each `/v1/messages` call the
proxy:

1. Captures the full request body
2. Strips `accept-encoding` from forwarded headers (so the API returns uncompressed
   SSE text, not gzip)
3. Forwards to `api.anthropic.com` over HTTPS
4. Streams the response back to Claude Code
5. Logs: system prompt size, CLAUDE.md marker counts in system vs messages, token
   counts from the SSE `message_start` event

CLAUDE.md markers are unique strings embedded in each test-env CLAUDE.md file
(`PROJECT_ROOT_LOADED`, `SRC_DIR_LOADED`, etc.) that make it easy to grep the raw API
payloads and confirm exactly where the content was injected.

---

## How Subdir CLAUDE.md Injection Works (short version)

When Claude Code executes a `Read` tool call on a file in `src/`:

1. It checks `query.readFileState` (an in-memory Map on the session object)
2. If `src/CLAUDE.md` has not been loaded yet in this subprocess:
   - Fires the `InstructionsLoaded` hook (`load_reason: nested_traversal`)
   - Appends the CLAUDE.md content as a `<system-reminder>` block **inside the tool
     result** (not the system prompt)
   - Adds the path to `readFileState` so it won't inject again this subprocess
3. The enriched tool result is sent to the LLM — it sees the instruction alongside
   the file content
4. When the turn is written to disk (`.jsonl` session file), the `<system-reminder>`
   is stripped — only raw file content is persisted
5. On session resume (new subprocess), `readFileState` is empty again, so the first
   Read triggers a fresh injection

See [`sF8` in cli.js](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
for the source-confirmed deduplication logic.
