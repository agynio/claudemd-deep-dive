# How Claude Code Reads CLAUDE.md Files: Research Report

## TL;DR

Claude Code loads subdirectory `CLAUDE.md` files **on demand**, not at session start.
Loading is triggered by the `Read` tool, injected directly into the tool result as a
`<system-reminder>` block, deduplicated per subprocess, and stripped from disk storage
so resumed sessions always start fresh.

---

## Test Setup

A test environment was created with `CLAUDE.md` files at multiple directory levels:

```
test-env/
  CLAUDE.md          ← root (MARKER: PROJECT_ROOT_LOADED)
  src/
    CLAUDE.md        ← subdir (MARKER: SRC_DIR_LOADED)
    main.py
    utils.py
    constants.py
    a.md
    b.md
  tests/
    CLAUDE.md        ← subdir (MARKER: TESTS_DIR_LOADED)
    test_main.py
  docs/
    CLAUDE.md        ← subdir (MARKER: DOCS_DIR_LOADED)
    README.md
```

An HTTP intercepting proxy was placed between Claude Code and the Anthropic API
(`ANTHROPIC_BASE_URL=http://127.0.0.1:9877`). The proxy logged every `/v1/messages`
request: system prompt size, message count, occurrence of each CLAUDE.md marker in
system prompt vs messages, and input/output token counts. Full request bodies were
saved to `proxy.bodies.jsonl` for deep inspection.

Tests used the `@anthropic-ai/claude-agent-sdk` TypeScript SDK with `settingSources: ["project"]`
to enable project CLAUDE.md loading, and the `InstructionsLoaded` hook to observe
when Claude Code fires the loading event.

---

## Finding 1: Only `Read` Triggers Subdir CLAUDE.md Loading

**Test:** Ran separate scenarios using each tool type against files in `src/`:
- `Bash` — ran `cat src/main.py`
- `Glob` — ran `src/**/*.py`
- `Write` — wrote a new file to `src/`
- `Read` — read `src/main.py`

**Result:**

| Tool  | `InstructionsLoaded` fired? | `src/CLAUDE.md` in API call? |
|-------|-----------------------------|-------------------------------|
| Bash  | ✗ no                        | ✗ no                          |
| Glob  | ✗ no                        | ✗ no                          |
| Write | ✗ no                        | ✗ no                          |
| Read  | ✓ yes                       | ✓ yes                         |

Only the `Read` tool triggers subdir CLAUDE.md loading. Listing, running, or writing
files does not.

---

## Finding 2: Injection Is in the Tool Result, Not the System Prompt

**Test:** Proxy logged `sys=` (system prompt chars) and `msg_markers=` (CLAUDE.md
marker occurrences across all messages) for every API call.

**Result:**

```
call #1: sys=154ch | msgs=1 | msg_markers=root/CLAUDE.md×1          ← before Read
call #2: sys=154ch | msgs=3 | msg_markers=root/CLAUDE.md×1,src/CLAUDE.md×1  ← after Read
```

System prompt size stays constant at `154ch` regardless of how many subdir CLAUDE.md
files are loaded. Zero system prompt growth.

The subdir CLAUDE.md content is injected as a `<system-reminder>` block appended to
the tool result of the triggering Read call:

```
msg[2] content (tool_result for reading src/main.py):
  "     1→def add(a: int, b: int) -> int:
        ...file content...

   <system-reminder>
   Contents of .../test-env/src/CLAUDE.md:

   # Source Directory Instructions
   MARKER: SRC_DIR_LOADED
   ...
   </system-reminder>"
```

The root `CLAUDE.md` is different: it is injected into `msg[0]`'s content array at
session start, also as a `<system-reminder>` block.

---

## Finding 3: Injection Is Sticky Within a Subprocess

**Test:** Within a single `query()` call, the agent read `src/a.md`, then (following
CLAUDE.md instructions) read `src/b.md`. Proxy tracked marker counts across all
subsequent API calls.

**Result:**

```
call #4: msgs=3  src×1  ← after reading a.md, injection in msg[2]
call #6: msgs=5  src×1  ← after reading b.md, msg[2] still carries the injection
```

Once `src/CLAUDE.md` is injected into `msg[2]`, that message stays in the in-memory
conversation history for the entire subprocess lifetime. Every subsequent LLM API call
includes `msg[2]` (with the injection) in its messages array. The instruction remains
visible to the model for all future turns — no re-injection needed.

---

## Finding 4: Deduplication — Once Per Subprocess Per Directory

**Test:** Same subprocess, two sequential reads of different files in `src/` (`a.md`
then `b.md`). Observed `InstructionsLoaded` hook events and tool result content.

**Result:**

```
read src/a.md  → InstructionsLoaded fires  → src/CLAUDE.md injected into tool_result
read src/b.md  → InstructionsLoaded does NOT fire  → tool_result is clean file content only
```

Only **one** `InstructionsLoaded` event fired for the entire scenario.

**Source code confirmation** (`cli.js`):

```js
function sF8(A, q, K) {
  for (let _ of A)
    if (!q.readFileState.has(_.path)) {    // check session-scoped Map
      q.readFileState.set(_.path, ...)     // mark as loaded
      ZF6(...)                             // fire InstructionsLoaded hook + inject
    }
    // else: already loaded this subprocess → skip entirely
}
```

`q.readFileState` is a `Map` on the query/session object. It persists for the entire
subprocess lifetime and prevents any re-injection for the same CLAUDE.md file.

---

## Finding 5: Parallel-Batched Reads — One Injection for the Batch

**Test:** Prompted the agent to "Read `src/main.py`, then `src/utils.py`, then
`src/constants.py`." Claude batched all three as parallel `tool_use` blocks in one
assistant message.

**Result:** Inspected `proxy.bodies.jsonl` to see the three tool results:

```
tool_result[0]  src/main.py      →  src×0  (no injection)
tool_result[1]  src/utils.py     →  src×0  (no injection)
tool_result[2]  src/constants.py →  src×1  ← injection in last result only
```

`InstructionsLoaded` fired once. When multiple files from the same directory are read
in a single parallel batch, `src/CLAUDE.md` is injected into exactly one tool result
(the last one processed). `q.readFileState` prevents any further injections within the
same batch.

---

## Finding 6: Resumed Sessions Start Fresh — Stripping at Write Time

**Test:** Ran a three-scenario chain (S1 → S2 → S3), each resuming the previous
session via `resume: sessionId`. All three read from `src/`. Inspected the on-disk
session file and the proxy marker counts.

**Result — session file on disk:**

```
python3 -c "... count 'SRC_DIR_LOADED' in each .jsonl line ..."

line 0: type=queue-operation  src×0
line 2: type=user (tool_result) src×0   ← stripped when written
line 3: type=assistant          src×0
...
```

The `<system-reminder>` injections are **stripped from tool results before writing to
disk**. The on-disk `.jsonl` contains clean file content only.

**Result — proxy marker counts for S3 (third subprocess, full history loaded):**

```
call (msgs=9, S3 first call):  src×0   ← full history of S1+S2 in memory, no src marker
call (msgs=11, after S3 Read): src×1   ← fresh injection from this subprocess's first Read
```

Despite `msgs=9` containing the full conversation history of two prior sessions that
each read from `src/`, the marker count is `src×0`. The prior injections were stripped
at write time. On the first Read in S3, a fresh injection happens (`src×1`).

**The lifecycle of a subdir CLAUDE.md injection:**

```
subprocess starts
  └─ read session file from disk (no system-reminders)
  └─ q.readFileState = {}  (empty)

first Read of src/file.py
  └─ sF8 checks readFileState → not found
  └─ inject src/CLAUDE.md into tool_result (IN MEMORY only)
  └─ readFileState.set("src/CLAUDE.md", ...)
  └─ write tool_result to disk WITHOUT the <system-reminder>  ← stripped here

all subsequent LLM calls this subprocess
  └─ src/CLAUDE.md visible in msg history (the injected tool_result is in memory)

any further Read of src/ files
  └─ sF8 checks readFileState → found → skip

subprocess exits
  └─ q.readFileState discarded
  └─ disk has clean session history
```

---

## Finding 7: Token Cost Is Minimal Due to Prompt Caching

**Test:** Proxy captured `input_tokens` (non-cached tokens only) from the SSE
`message_start` event across all scenarios.

**Result:**

```
call before Read:  in=3    (3 non-cached tokens — new user prompt)
call after Read:   in=1    (1 non-cached token — nearly everything cached)
```

The Anthropic API returns three token fields:
- `input_tokens` — tokens NOT from cache (what we capture)
- `cache_read_input_tokens` — tokens served from cache (~10× cheaper, not captured)
- `cache_creation_input_tokens` — tokens written to new cache entry

Within a subprocess's call chain, all prior messages are cached after the first call.
The only non-cached tokens are the new tail since the last cache checkpoint — hence
`in=1`. The actual total context grows with each turn, but is served cheaply from
cache.

Across subprocess boundaries, the stripped tool_results differ from the cached versions
(which included `<system-reminder>`), causing a cache miss on those messages. However
the cost is bounded: each subprocess only pays once for its first Read in a directory.

---

## Summary Table

| Behaviour | Result |
|-----------|--------|
| What triggers subdir CLAUDE.md load | `Read` tool only — not Bash, Glob, Write |
| Where injection appears | Inside tool_result as `<system-reminder>`, not in system prompt |
| System prompt growth | None — stays constant regardless of subdirs loaded |
| Re-injection within same subprocess | Never — `q.readFileState` deduplicates |
| Visibility after injection | Sticky — stays in message history for all subsequent LLM calls |
| Parallel batched reads (same dir) | One injection total for the batch |
| Resumed session (new subprocess) | `readFileState` starts empty → fresh injection on first Read |
| On-disk storage | `<system-reminder>` stripped before writing — disk is always clean |
| Token cost of re-injection (new subprocess) | Near-zero due to prompt caching |

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
                    │  │   readFileState.set(path, ...)    │
                    │  │   fire InstructionsLoaded hook    │
                    │  └─ found: skip                      │
                    │                                      │
                    │  write tool_result to .jsonl         │
                    │  (system-reminder STRIPPED)          │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │  LLM API call                        │
                    │  messages = [..., tool_result        │
                    │             WITH system-reminder]    │
                    │  ← model sees CLAUDE.md here         │
                    └─────────────────────────────────────┘
```
