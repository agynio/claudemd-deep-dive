# I had questions about how CLAUDE.md files actually work in Claude Code agents — so I built a proxy and traced every API call

## First: the different types of CLAUDE.md

Most people know you can put a `CLAUDE.md` at your project root and Claude will pick
it up. But Claude Code actually supports them at multiple levels:

- **Global** (`~/.claude/CLAUDE.md`) — your personal instructions across all projects
- **Project root** (`<project>/CLAUDE.md`) — project-wide rules
- **Subdirectory** (`<project>/src/CLAUDE.md`, `<project>/tests/CLAUDE.md`, etc.) — directory-specific rules

The first two are simple: Claude loads them **once at session start** and they are
always in context for the whole conversation.

Subdirectories are different. The docs say they are loaded *"on demand as Claude
navigates your codebase"* — which sounds useful but explains nothing about the actual
mechanism. Mid-conversation injection into a live LLM context raises a lot of
questions the docs don't answer.

---

## The questions we couldn't answer from the docs

Been building agents with the Claude Code Agent SDK and we kept putting instructions
into subdirectory `CLAUDE.md` files. Things like "always add type hints in `src/`" or
"use pytest in `tests/`". It worked, but we had zero visibility into *how* it worked.

- **What exactly triggers the load?** A file read? Any tool that touches the dir?
- **Does it reload every time?** 10 file reads in `src/` = 10 injections?
- **Do instructions pile up in context?** Could this blow up token costs?
- **Where does the content actually go?** System prompt? Messages? Does the system
  prompt grow every time a new subdir is accessed?
- **What happens when you resume a session?** Are the instructions still active or
  does Claude start blind?

We couldn't find solid answers so we built an intercepting HTTP proxy between Claude
Code and the Anthropic API and traced every single `/v1/messages` call. Here's what
we found.

---

## The Setup

Test environment with `CLAUDE.md` files at multiple levels, each with a unique marker
string so we could grep raw API payloads:

```
test-env/
  CLAUDE.md          ← "MARKER: PROJECT_ROOT_LOADED"
  src/
    CLAUDE.md        ← "MARKER: SRC_DIR_LOADED"
    main.py
    utils.py
  tests/
    CLAUDE.md        ← "MARKER: TESTS_DIR_LOADED"
  docs/
    CLAUDE.md        ← "MARKER: DOCS_DIR_LOADED"
```

Proxy on `localhost:9877`, Claude Code pointed at it via `ANTHROPIC_BASE_URL`. For
every API call we logged: system prompt size, message count, marker occurrences in
system vs messages, and token counts. Full request bodies saved for inspection.

---

## Finding 1: Only the `Read` Tool Triggers Loading

This was the first surprise. We tested Bash, Glob, Write, and Read against `src/`:

| Tool | `InstructionsLoaded` hook fired? | Content in API call? |
|------|----------------------------------|----------------------|
| `Bash` (cat src/file.py) | ✗ no | ✗ no |
| `Glob` (src/**/*.py) | ✗ no | ✗ no |
| `Write` (new file in src/) | ✗ no | ✗ no |
| `Read` (src/file.py) | ✓ yes | ✓ yes |

**Practical implication:** if your agent only writes files or runs bash in a directory,
it will never see that directory's CLAUDE.md. An agent that generates-and-writes code
without reading first is running blind to your subdir instructions.

The common pattern of "read then edit" is what makes subdir CLAUDE.md work. Skipping
the read means skipping the instructions.

---

## Finding 2: It's Concatenated Directly Into the Tool Output Text

We expected the system prompt to grow. Wrong. We expected a separate message to be
injected. Also wrong.

The CLAUDE.md content is appended **directly to the end of the file content string**
inside the same tool result — as if the file itself contained the instructions:

```
tool_result for reading src/main.py:

  "     1→def add(a: int, b: int) -> int:
        2→    return a + b
        ...rest of file content...

   <system-reminder>
   Contents of src/CLAUDE.md:

   # Source Directory Instructions
   ...your instructions here...
   </system-reminder>"
```

Not a new message. Not the system prompt. Just text bolted onto the end of whatever
file Claude just read. From the model's perspective, reading a file in `src/` is
indistinguishable from reading a file that happens to have extra content appended at
the bottom.

Proxy output confirms the system prompt never moves:

```
call before Read:  sys=154ch  msgs=1
call after Read:   sys=154ch  msgs=3   ← same size, CLAUDE.md only in messages
```

**154 chars regardless of how many subdirs are loaded. Zero system prompt growth.**

Root `CLAUDE.md` is handled differently — it lands in `msg[0]` at session start as
a `<system-reminder>` block, before any turns. Subdirs never touch the system prompt.

---

## Finding 3: Once Injected, It Stays Visible for the Whole Session

After the injection lands in `msg[2]` (the tool result), that message stays in the
in-memory conversation history for the entire agent run. Every subsequent LLM API call
sends the full messages array including `msg[2]`:

```
after reading src/a.md:     msgs=3  src×1  ← injected in msg[2]
after reading src/b.md:     msgs=5  src×1  ← same msg[2] still there
after editing src/main.py:  msgs=7  src×1  ← still there
```

No re-injection happens. It just stays in history, like any other prior turn in the
conversation. The instructions are visible to the model for every subsequent LLM call
in that session.

---

## Finding 4: Deduplication — One Injection Per Directory Per Session

We expected that if Claude reads 10 files in `src/`, we'd get 10 copies of
`src/CLAUDE.md` in the context. We were wrong.

Test: set `src/CLAUDE.md` to instruct the agent *"after reading any file in src/, you
MUST also read src/b.md."* Then asked the agent to read `src/a.md`.

Result:
- Read `src/a.md` → injection fired, `InstructionsLoaded` hook fired
- Agent (following instruction) read `src/b.md` → **no injection, hook did not fire**

Only one `InstructionsLoaded` event for the whole scenario. Source code confirms it
(`cli.js`):

```js
function sF8(instructions, query, triggerFile) {
  for (let instruction of instructions)
    if (!query.readFileState.has(instruction.path)) {
      query.readFileState.set(instruction.path, ...)  // mark loaded
      fireInstructionsLoadedHook(...)                  // inject once
    }
    // else: already loaded → skip
}
```

`query.readFileState` is a `Map` on the session object. First Read in a directory:
inject. Every subsequent Read in the same directory: skip entirely. 10 file reads in
`src/` = **1 injection, not 10**.

---

## Finding 5: Session Resume — Fresh Injection Every Time

**Question:** if I resume a session that already read `src/` files, are the
instructions still active?

Answer: **no**. Every session is written to a `.jsonl` file on disk as it happens
(append-only, crash-safe). But the `<system-reminder>` content is **stripped before
writing to disk**:

```
# What's sent to the API (in memory):
tool_result: "file content\n<system-reminder>src/CLAUDE.md content</system-reminder>"

# What gets written to .jsonl on disk:
tool_result: "file content"
```

Proxy evidence — third session resuming a chain that already read `src/` twice:

```
first call (msgs=9, full history of 2 prior sessions): src×0
                ↑ both prior sessions read src/ but injections are gone from disk

after first Read in this session (msgs=11): src×1
                ↑ fresh injection — as if src/CLAUDE.md had never been seen
```

The `readFileState` Map lives in memory only. When a subprocess exits, it's gone.
When you resume, `readFileState` starts empty and the disk history has no
`<system-reminder>` content — so the first Read re-injects freshly.

**What this means for agents with many session resumes:** subdir CLAUDE.md is
re-loaded on every resume. This is by design — the instructions are always fresh,
never stale. But it means an agent that resumes and only writes (no reads) will never
see the subdir instructions at all.

---

## Finding 6: Token Cost Is Near-Zero

The original concern was that re-injection on every session resume would burn tokens.
It doesn't, because of prompt caching.

The Anthropic API returns three token fields in streaming responses:
- `input_tokens` — non-cached tokens (what we initially captured)
- `cache_read_input_tokens` — served from cache, ~10× cheaper
- `cache_creation_input_tokens` — written to new cache entry

We were only capturing `input_tokens` and seeing values like `in=1`, which looked
wrong. It's not wrong — it means almost everything was served from cache. Within a
single session, each API call caches all prior messages. Only the tiny new tail beyond
the last checkpoint is non-cached.

Across session resumes, the stripped tool results cause a cache miss (the cached
version had `<system-reminder>`, the resumed version doesn't). But it's a one-time
cost per directory per resume, not per-turn — and even that is bounded by the size of
one CLAUDE.md file.

In practice: if your CLAUDE.md is 200 tokens, resuming a session costs ~200 extra
tokens once (to re-cache the new tool result), then everything is cached again.

---

## TL;DR

| Question | Answer |
|----------|--------|
| What triggers loading? | `Read` tool only |
| Where does it appear? | Inside the tool result, as `<system-reminder>` |
| Does system prompt grow? | Never |
| Re-injected on every file read? | No — once per subprocess per directory |
| Stays in context after injection? | Yes — sticky in message history |
| Session resume? | Fresh injection on first Read (disk is always clean) |
| Token cost? | Near-zero — prompt caching handles it |

---

## Practical Takeaways

1. **Your agent must Read before it can follow subdir instructions.** Write-only or
   Bash-only workflows are invisible to CLAUDE.md. Design workflows that read at
   least one file in a directory before acting on it.

2. **System prompt does not grow.** You can have CLAUDE.md files in dozens of
   subdirectories without worrying about system prompt bloat. Each is only injected
   once, into a tool result.

3. **Session resumes re-load instructions automatically** on the first Read. You don't
   need to do anything special — but be aware that if a resumed session never reads
   from a directory, it never sees that directory's instructions.

4. **Token cost is effectively free** after the first session. Prompt caching
   absorbs almost everything within a session chain.

---

Full experiment code, proxy, and results: https://github.com/[your-repo]
