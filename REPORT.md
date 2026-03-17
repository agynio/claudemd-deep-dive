# How Claude Code Reads CLAUDE.md Files: Research Report

## Background: Where CLAUDE.md Files Live

Claude Code supports `CLAUDE.md` files at multiple levels, and they are **not all
loaded the same way**:

| Location | Example | When loaded | How |
|----------|---------|-------------|-----|
| Global | `~/.claude/CLAUDE.md` | Session start | Into `msg[0]` as `<system-reminder>` |
| Project root | `<project>/CLAUDE.md` | Session start | Into `msg[0]` as `<system-reminder>` |
| Subdirectory | `<project>/src/CLAUDE.md` | On demand, mid-session | ? |

The global and project-root files are straightforward — Claude loads them once at the
start of every session and they are always in context. The documentation mentions that
subdirectory files are read *"on demand as Claude navigates your codebase"*, but that
description leaves a lot open:

- What exactly triggers the load?
- Does it happen mid-conversation, and if so where does the content go?
- Does it cost tokens every time?
- What survives a session restart?

We couldn't find answers to these questions, so we built an intercepting HTTP proxy
and ran a series of experiments to trace exactly what happens.

---

## Why We Investigated This

When building agents with the Claude Code Agent SDK we started putting instructions
into `CLAUDE.md` files in subdirectories — things like "always add type hints in
`src/`" or "run tests before committing in `tests/`". It worked, but we had no idea
*how* it worked, and that uncertainty led to real questions:

- **When does it actually load?** Does Claude read `src/CLAUDE.md` when it first
  touches the directory, or is it pre-loaded at session start?
- **Does it reload every time?** If Claude reads five files in `src/`, does it load
  `src/CLAUDE.md` five times?
- **Is there any deduplication?** Or do the instructions pile up in context?
- **What happens after a session restart?** If I resume a session, are the subdir
  instructions still active, or do they need to be re-triggered?
- **How much does it cost?** Each injection is potentially hundreds of tokens. If
  it re-injects on every file read, token costs could blow up.
- **Where exactly does the content go?** System prompt? Messages? Does it grow the
  system prompt on every new subdir?

To answer these we built an intercepting HTTP proxy between Claude Code and the
Anthropic API and traced every `/v1/messages` call across a series of experiments.

---

## TL;DR

Subdir `CLAUDE.md` files are loaded **on demand by the `Read` tool**, injected into
the **tool result** (not the system prompt), deduplicated per subprocess via an
in-memory Map, stripped from disk before the session is saved, and re-injected fresh
on the first Read of any resumed session. Token cost is near-zero thanks to prompt
caching.

---

## Test Setup

A test environment with `CLAUDE.md` files at multiple directory levels, each
containing a unique marker string:

```
test-env/
  CLAUDE.md          ← root   (MARKER: PROJECT_ROOT_LOADED)
  src/
    CLAUDE.md        ← subdir (MARKER: SRC_DIR_LOADED)
    main.py
    utils.py
    constants.py
  tests/
    CLAUDE.md        ← subdir (MARKER: TESTS_DIR_LOADED)
    test_main.py
  docs/
    CLAUDE.md        ← subdir (MARKER: DOCS_DIR_LOADED)
    README.md
```

An HTTP intercepting proxy (`src/proxy.ts`) on port 9877. Claude Code was pointed
at it via `ANTHROPIC_BASE_URL=http://127.0.0.1:9877`. For every `/v1/messages` call
the proxy logged:
- System prompt character count
- Number of messages in the array
- Count of each CLAUDE.md marker in the system prompt vs messages
- `input_tokens` (non-cached) from the SSE `message_start` event

Full request bodies were saved to `proxy.bodies.jsonl` for deep inspection
(committed — see [proxy.bodies.jsonl](./proxy.bodies.jsonl)).

Tests used the `@anthropic-ai/claude-agent-sdk` TypeScript SDK with the
`InstructionsLoaded` hook to observe loading events, and `settingSources: ["project"]`
to enable project CLAUDE.md loading.

Source code evidence was extracted from `@anthropic-ai/claude-agent-sdk/cli.js` with
byte offsets and saved to [results-source.json](./results-source.json) (script:
`src/extract-source.ts`).

---

## Finding 1: Only the `Read` Tool Triggers Subdir CLAUDE.md Loading

**Question:** Does Claude load `src/CLAUDE.md` when it runs bash in `src/`, globs
files there, or writes a new file there?

**Test:** Separate scenarios using each tool against `src/`:

| Tool  | `InstructionsLoaded` fired? | `src/CLAUDE.md` in API call? |
|-------|-----------------------------|-------------------------------|
| Bash  | ✗ no                        | ✗ no                          |
| Glob  | ✗ no                        | ✗ no                          |
| Write | ✗ no                        | ✗ no                          |
| Read  | ✓ yes                       | ✓ yes                         |

**Practical implication:** If your agent only writes files or runs bash commands in a
directory, it will never see that directory's `CLAUDE.md`. A common agent pattern is
to read a file before editing it — that read is what loads the instructions. An agent
that generates and writes code without reading first operates blind to subdir rules.

---

## Finding 2: Concatenated Directly Into the Tool Output Text

**Question:** Where does the CLAUDE.md content actually appear — in the system prompt,
a separate message, or somewhere else?

**Test:** Proxy logged `sys=` (system prompt chars) and marker occurrences in both
system prompt and messages for every API call.

```
call before Read:  sys=154ch | msgs=1 | msg_markers: root/CLAUDE.md×1
call after Read:   sys=154ch | msgs=3 | msg_markers: root/CLAUDE.md×1, src/CLAUDE.md×1
```

System prompt size stays constant at `154ch` — **zero growth** regardless of how many
subdir CLAUDE.md files are loaded. It is not a separate new message either.

The CLAUDE.md content is appended **directly to the end of the file content string**
inside the same tool result — as if the file itself contained the instructions.

**Proof — `proxy.bodies.jsonl` request 3, `msg[2]` tool_result:**

```
"     1→# File A\n     2→\n     3→MARKER: FILE_A_CONTENT\n..."

<system-reminder>
Contents of .../test-env/src/CLAUDE.md:

# Source Directory Instructions
MARKER: SRC_DIR_LOADED
...instructions...
</system-reminder>
```

The file content and the CLAUDE.md instructions are a single concatenated string in
one `tool_result` block. From the model's perspective, reading a file in `src/` is
indistinguishable from reading a file that happens to have extra content at the bottom.

**Source proof — `results-source.json` (call site, offset 5373114):**

```js
// Inside the Read tool's result-building code:
if (K = A.file.content ? _B9(A) + qB9(A.file) : "")
```

`_B9(A)` returns the `<system-reminder>` block; `qB9(A.file)` returns the file
content. The CLAUDE.md block is **prepended** to the file content.

`_B9` → `lJ7` → wraps in `<system-reminder>`:

```js
function lJ7(A) {
  let q = Cz8(A);
  if (!q) return "";
  return `<system-reminder>${q}</system-reminder>\n`;
}
```

Root `CLAUDE.md` is handled differently: it lands in `msg[0]`'s content array at
session start as a `<system-reminder>` block, before any turns. Subdirs never touch
the system prompt.

---

## Finding 3: Instructions Stay Visible for the Rest of the Session

**Question:** Once loaded, does the CLAUDE.md content stay in context, or does it
disappear after that turn?

The injection lands in `msg[2]` (the tool result). That message stays in the
in-memory conversation history for the entire subprocess lifetime. Every subsequent
LLM API call sends the full messages array including `msg[2]`:

```
call after read src/a.md:   msgs=3  src×1   ← injected in msg[2]
call after read src/b.md:   msgs=5  src×1   ← same msg[2] still carried forward
call after edit src/main.py: msgs=7  src×1   ← still there
```

No re-injection needed. Once it's in message history it stays there, just like any
other prior turn.

---

## Finding 4: Deduplication — Once Per Subprocess Per Directory

**Question:** If Claude reads 10 files in `src/`, does `src/CLAUDE.md` get injected
10 times?

**Test:** Prompted the agent to read `src/a.md`. `src/CLAUDE.md` instructed it to
then also read `src/b.md`. Observed hook events and tool result content.

```
read src/a.md  → InstructionsLoaded fires  → src/CLAUDE.md injected into tool_result
read src/b.md  → InstructionsLoaded does NOT fire → tool_result is clean file content only
```

Only **one** `InstructionsLoaded` event for the entire scenario. The source code
confirms why — `results-source.json` (offset 5371689), Read tool's `call` function:

```js
async call({file_path: A, ...}, z, _, w) {
  let { readFileState: O, ... } = z   // O is the session-scoped Map
  // ...
  // inside L94 → _B9(A) checks the Map before injecting
}

function _B9(A) {
  let q = h94.get(A);          // retrieve stored CLAUDE.md for this dir
  if (q === undefined) return "";
  return lJ7(q);               // wrap in <system-reminder> and return
}
```

The `readFileState` Map lives on the session object (`z`) for the entire subprocess
lifetime. `h94` is populated on first traversal; subsequent calls to `_B9` for the
same directory find it already stored and return the same block — but the Read tool
only calls `_B9` once per directory (the Map check gates the injection upstream).
First Read in a directory: inject and mark. Every further Read: skip completely.

---

## Finding 5: Parallel-Batched Reads — One Injection for the Batch

**Test:** Agent read `src/main.py`, `src/utils.py`, and `src/constants.py` in a
single parallel batch (all three as `tool_use` blocks in one assistant message).

Inspecting `proxy.bodies.jsonl`:

```
tool_result[0]  src/main.py      →  src×0   (no injection)
tool_result[1]  src/utils.py     →  src×0   (no injection)
tool_result[2]  src/constants.py →  src×1   ← injection in last result only
```

One `InstructionsLoaded` fired. Even within a parallel batch, `readFileState` prevents
duplicates. The CLAUDE.md content appears in the last tool result processed.

---

## Finding 6: Resumed Sessions — Fresh Injection Every Time

**Question:** If I resume a session that already read files in `src/`, do the
instructions carry over or does Claude have to re-load them?

**Test:** Three-scenario chain (S1 → S2 → S3), each resuming the previous session.
All three read from `src/`. Inspected the on-disk session file and proxy marker counts.

**What's on disk:**

Every turn is written to a `.jsonl` file in `~/.claude/projects/` as it happens
(append-only, immediate — crash safe). But the `<system-reminder>` is **stripped
before writing**. The on-disk tool result contains only the raw file content:

```
# In memory (sent to API):
tool_result: "file content...\n<system-reminder>src/CLAUDE.md content</system-reminder>"

# Written to .jsonl (on disk):
tool_result: "file content..."
```

**Proxy evidence — S3's first API call (msgs=9, full history of S1+S2):**

```
call (msgs=9):   src×0   ← S1 and S2 both read src/, but their injections are gone
call (msgs=11):  src×1   ← fresh injection from S3's first Read
```

Despite `msgs=9` containing history from two prior sessions that each read `src/`
files, the marker count is zero. The injections were stripped at write time. Each new
subprocess starts with an empty `readFileState` and clean message history — the first
Read always re-injects.

**The complete lifecycle:**

```
subprocess starts
  ├─ reads .jsonl from disk → messages[] in memory (no system-reminders)
  └─ q.readFileState = {}  (empty)

first Read of src/file.py
  ├─ sF8 checks readFileState → not found
  ├─ appends <system-reminder> to tool_result IN MEMORY
  ├─ readFileState.set("src/CLAUDE.md")
  └─ writes tool_result to disk WITHOUT the <system-reminder>

subsequent LLM calls this subprocess
  └─ src/CLAUDE.md visible via normal message history (msg[N] carries it)

any further Read of src/ files
  └─ sF8 finds it in readFileState → skips entirely

subprocess exits
  ├─ readFileState discarded
  └─ disk has clean history, ready for next resume
```

---

## Finding 7: Token Cost Is Near-Zero Due to Prompt Caching

**Question:** Does re-injecting CLAUDE.md on every session resume blow up token costs?

The proxy captures `input_tokens` from the SSE `message_start` event — this is the
**non-cached** portion only. The API also returns `cache_read_input_tokens` (tokens
served from cache, ~10× cheaper) which we weren't initially capturing.

```
call before Read:  input_tokens=3   (3 non-cached — just the new user prompt)
call after Read:   input_tokens=1   (1 non-cached — everything else is cached)
```

Within a subprocess's call chain, all prior messages are cached after the first call.
Only the new "tail" beyond the last cache checkpoint counts as non-cached — hence
`in=1`. The total context grows with each turn, but the cost grows very slowly because
the growing portion is served from cache.

Across subprocess boundaries the stripped tool results differ from what was originally
cached (the cached versions contained `<system-reminder>`), causing a cache miss on
those messages. But this is a one-time cost per session resume per directory — not
per-turn.

---

## Summary

| Question | Answer |
|----------|--------|
| What triggers subdir CLAUDE.md? | `Read` tool only — not Bash, Glob, Write |
| Where does content appear? | Inside tool_result as `<system-reminder>`, not system prompt |
| Does system prompt grow? | Never — stays constant regardless of subdirs loaded |
| Re-injected on every Read? | No — once per subprocess per directory (`readFileState` Map) |
| Stays visible after injection? | Yes — sticky in message history for all subsequent turns |
| Parallel batched reads? | One injection total for the batch |
| Session resume (new subprocess)? | `readFileState` starts empty → fresh injection on first Read |
| Persisted to disk? | `<system-reminder>` stripped before writing |
| Token cost? | Near-zero within a session; one cache miss per directory on resume |

---

## Architecture Diagram

```
                    CLAUDE CODE SUBPROCESS
                    ┌─────────────────────────────────────┐
session start       │  read .jsonl from disk              │
                    │  → messages[] in memory (clean)     │
                    │  → q.readFileState = Map{}           │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │  LLM API call                        │
                    │  messages = [user prompt, ...]       │
                    └──────────────┬──────────────────────┘
                                   │ tool_use: Read(src/file.py)
                    ┌──────────────▼──────────────────────┐
                    │  Read tool executes                  │
                    │  sF8 checks readFileState            │
                    │  ├─ NOT found:                       │
                    │  │   inject <system-reminder>        │
                    │  │   into tool_result (memory only)  │
                    │  │   readFileState.set(path)         │
                    │  │   fire InstructionsLoaded hook    │
                    │  └─ found: skip entirely             │
                    │                                      │
                    │  write tool_result to .jsonl on disk │
                    │  (<system-reminder> STRIPPED)        │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │  LLM API call                        │
                    │  messages = [..., tool_result        │
                    │             WITH system-reminder]    │
                    │  ← model sees CLAUDE.md here         │
                    └─────────────────────────────────────┘
```
