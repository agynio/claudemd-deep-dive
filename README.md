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

```
.
├── src/
│   ├── experiment.ts     # Experiment 1: trigger/dedup/session (9 scenarios)
│   ├── experiment2.ts    # Experiment 2: same-file, glob, write, compaction edge cases
│   ├── experiment3.ts    # Experiment 3: token counting via proxy interception
│   └── proxy.ts          # Intercepting HTTP proxy — logs every /v1/messages call
│
├── test-env/             # Isolated workspace Claude Code runs inside
│   ├── CLAUDE.md         # Root-level (loaded at session_start)
│   ├── src/
│   │   ├── CLAUDE.md     # Subdir (loaded on first Read into src/)
│   │   ├── main.py
│   │   ├── utils.py
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
└── REPORT.md             # Full technical report
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

```bash
npm run exp1   # Basic trigger/session scenarios → results.json
npm run exp2   # Edge cases (glob, write, compaction) → results2.json
npm run exp3   # Proxy token counting → results3.json
```

Experiment 3 must run with `CLAUDECODE` unset to allow nested Claude Code sessions —
the `npm run exp3` script handles this automatically (`CLAUDECODE= npx tsx ...`).

Full request bodies are written to `proxy.bodies.jsonl` (gitignored) for deep
inspection of raw API payloads.

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

Source-confirmed: see `sF8` function in
[`@anthropic-ai/claude-agent-sdk/cli.js`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
for the deduplication logic.
