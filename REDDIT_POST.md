# I reverse-engineered exactly how Claude Code loads CLAUDE.md files — here's what actually happens

Been building agents with the Claude Code SDK and had a nagging question: when exactly does Claude read subdirectory `CLAUDE.md` files, and does it keep re-reading them? I couldn't find solid answers so I built an intercepting proxy and ran a series of experiments. Here's what I found.

---

## The Setup

Test environment with `CLAUDE.md` files at multiple levels:

```
project/
  CLAUDE.md          ← root
  src/
    CLAUDE.md        ← subdir
    main.py
    utils.py
  tests/
    CLAUDE.md        ← subdir
  docs/
    CLAUDE.md        ← subdir
```

I placed an HTTP proxy between Claude Code and the Anthropic API
(`ANTHROPIC_BASE_URL=http://localhost:9877`), stripped `accept-encoding` so responses
stay as readable SSE text, and logged every `/v1/messages` call: system prompt size,
message count, CLAUDE.md marker occurrences, and token counts. Full request bodies
saved for inspection.

Then I ran scenarios and watched exactly what got sent to the API.

---

## Finding 1: Only the `Read` Tool Triggers Subdir CLAUDE.md Loading

Tested each tool type against files in `src/`:

| Tool | Hook fired? | CLAUDE.md injected? |
|------|------------|----------------------|
| `Bash` (cat src/file.py) | ✗ | ✗ |
| `Glob` (src/**/*.py) | ✗ | ✗ |
| `Write` (new file in src/) | ✗ | ✗ |
| `Read` (src/file.py) | ✓ | ✓ |

**Only `Read` triggers it.** If your agent only writes or runs bash commands in a
directory, it will never see that directory's `CLAUDE.md`.

---

## Finding 2: The Injection Goes Into the Tool Result, Not the System Prompt

This one surprised me. I expected subdir CLAUDE.md to expand the system prompt. It doesn't.

```
call before Read:  sys=154ch  msgs=1  (system prompt constant)
call after Read:   sys=154ch  msgs=3  src/CLAUDE.md×1 in messages
```

The system prompt **never changes**. Instead, Claude Code appends the CLAUDE.md content
directly into the tool result of the triggering Read call, as a `<system-reminder>` block:

```
tool_result for reading src/main.py:
  "     1→def add(a, b):
        ...file content...

   <system-reminder>
   Contents of .../src/CLAUDE.md:

   # Source Directory Instructions
   ...instructions...
   </system-reminder>"
```

The model sees it as part of the file read response, not as a persistent system instruction.

Root `CLAUDE.md` works differently — it IS in `msg[0]` at session start, also as a
`<system-reminder>` block. Subdirs are always lazy/on-demand.

---

## Finding 3: Once Injected, It Stays Visible (It's Sticky in Memory)

After the injection lands in `msg[2]` (the tool result), that message stays in the
in-memory conversation history for the entire agent run. Every subsequent LLM call
includes it:

```
call after read src/a.md:   msgs=3  src×1   ← injected in msg[2]
call after read src/b.md:   msgs=5  src×1   ← same msg[2] still there
```

The model sees the instruction for all future turns without any re-injection. It's
just normal message history at that point.

---

## Finding 4: Deduplication Is Per-Subprocess, Not Per-File

Within a single agent run (single process), `src/CLAUDE.md` is **never injected more
than once**, no matter how many files in `src/` are read.

I tested this by setting `src/CLAUDE.md` to instruct the agent: *"after reading any
file in src/, you MUST also read src/b.md."* Then asked the agent to read `src/a.md`.

Result:
- Agent read `src/a.md` → injection happened → `InstructionsLoaded` hook fired
- Agent (following the instruction) read `src/b.md` → **no injection, hook did not fire**

The source code confirms this. In `cli.js`:

```js
function sF8(instructions, query, triggerFile) {
  for (let instruction of instructions)
    if (!query.readFileState.has(instruction.path)) {
      query.readFileState.set(instruction.path, ...)  // mark loaded
      fireInstructionsLoadedHook(...)                  // inject
    }
    // else: already loaded → skip entirely
}
```

`query.readFileState` is a `Map` on the session object — it persists for the entire
process lifetime. First Read in the directory: inject. Every subsequent Read: skip.

---

## Finding 5: Parallel Reads — One Injection for the Whole Batch

When Claude batches multiple reads as parallel `tool_use` calls in one message, only
**one** injection happens for the entire batch, in the last tool result processed:

```
msg[1] assistant: [tool_use: Read(src/main.py), tool_use: Read(src/utils.py), tool_use: Read(src/constants.py)]
msg[2] user:      [tool_result: main.py content     ← no injection
                   tool_result: utils.py content    ← no injection
                   tool_result: constants.py content + <system-reminder>src/CLAUDE.md</system-reminder>]
```

`InstructionsLoaded` fires once. `readFileState` prevents duplicates even within a batch.

---

## Finding 6: Sessions Are Written to Disk — Injections Are Stripped

Every turn is appended to a `.jsonl` file in `~/.claude/projects/` as it happens.
The write is append-only and immediate (crash recovery).

But here's the key: **the `<system-reminder>` content is stripped before writing to disk**.
The on-disk tool result contains only the raw file content.

```
# What was sent to the API (in memory):
tool_result: "file content...\n<system-reminder>src/CLAUDE.md content</system-reminder>"

# What gets written to .jsonl (on disk):
tool_result: "file content..."
```

When a session is resumed (new process, same session ID), the new process reads the
clean `.jsonl`, reconstructs messages without any injections, and `readFileState`
starts empty. The first Read in `src/` triggers a fresh injection, just like a brand
new session.

So "per-subprocess" deduplication means:

- **Same process, 10 reads in src/**: 1 injection total, stays in memory
- **Resume session, 1 read in src/**: 1 fresh injection (prior stripped from disk)
- **Resume session, no reads**: never sees src/CLAUDE.md at all

---

## Finding 7: Token Cost Is Nearly Zero Thanks to Caching

The proxy captures `input_tokens` from the SSE stream — this is the **non-cached**
portion only. Separate fields (`cache_read_input_tokens`, `cache_creation_input_tokens`)
carry the rest, which we weren't capturing initially.

```
call before Read:  input_tokens=3   (just the new user prompt, everything else cached)
call after Read:   input_tokens=1   (1 non-cached token — prior context all cached)
```

Within a single process, each API call caches all prior messages. The re-injection
across subprocess boundaries does cause a cache miss on that specific tool result
(content changed — stripped vs unstripped), but it's a one-time cost per session
resume per directory. In practice negligible.

---

## Summary

| Question | Answer |
|----------|--------|
| What triggers subdir CLAUDE.md? | `Read` tool only |
| Where does it appear? | In the tool result, as `<system-reminder>` |
| Does it grow the system prompt? | No — system prompt stays constant |
| Re-injected on every Read? | No — once per process per directory |
| Visible after injection? | Yes — stays in message history for all future turns |
| Parallel reads? | One injection for the whole batch |
| Persisted to disk? | Content is stripped before writing |
| Resumed sessions? | Fresh injection on first Read (starts clean) |
| Token cost? | Near-zero — prompt caching handles it |

---

## Practical Implications

**If your agent only writes files or runs bash in a directory, it will never see that
directory's CLAUDE.md.** A common pattern is to read a file before editing it — this
is also what triggers the instruction load. If your workflow skips the read (e.g. pure
code generation with Write), the subdir instructions are invisible.

**Resumed sessions re-inject on first Read.** This is mostly fine but means the
injection cost is paid once per session resume, not once ever. If you're resuming
sessions frequently and the directory CLAUDE.md is large, that's a recurring (though
cached) cost.

**Instructions are visible for the whole process lifetime after injection**, even if
the agent navigates to other directories. The `<system-reminder>` stays in message
history. It doesn't disappear when the agent "leaves" the directory.

---

Code for all experiments: https://github.com/[your-repo]

Happy to answer questions about methodology or specific edge cases.
