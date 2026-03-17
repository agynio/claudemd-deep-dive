/**
 * Experiment 2: Deeper investigation of session state and edge cases
 * - Same file accessed twice in same session
 * - Glob vs Read triggering behavior (clarify)
 * - Compaction scenario (fill context, trigger compact, re-access)
 */

import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, readFileSync } from "fs";
import { resolve } from "path";

const TEST_ENV = resolve(new URL(".", import.meta.url).pathname, "../test-env");
const PROJECT_ROOT = resolve(new URL(".", import.meta.url).pathname, "../..");
const RESULTS_FILE = resolve(new URL(".", import.meta.url).pathname, "../results2.json");

// ─── Tracing ───────────────────────────────────────────────────────────────

interface TraceEvent {
  ts: string;
  scenario: string;
  type: string;
  data: Record<string, unknown>;
}

const allEvents: TraceEvent[] = [];
let currentScenario = "init";

function record(type: string, data: Record<string, unknown>) {
  const event: TraceEvent = { ts: new Date().toISOString(), scenario: currentScenario, type, data };
  allEvents.push(event);
  const prefix = `  [${type.padEnd(20)}]`;
  if (type === "INSTRUCTIONS_LOADED") {
    console.log(`${prefix} ${data.file_path} | reason=${data.load_reason} | trigger=${data.trigger_file_path ?? "-"}`);
  } else if (type === "TOOL_USE") {
    console.log(`${prefix} ${data.tool_name} | ${JSON.stringify(data.tool_input).slice(0, 90)}`);
  } else if (type.startsWith("COMPACT")) {
    console.log(`${prefix} phase=${data.phase} | trigger=${data.trigger}`);
  } else if (type === "RESPONSE_MARKERS") {
    console.log(`${prefix} ${JSON.stringify(data.found)}`);
  }
}

const instructionsLoadedHook: HookCallback = async (input) => {
  if (input.hook_event_name === "InstructionsLoaded") {
    record("INSTRUCTIONS_LOADED", {
      file_path: input.file_path.replace(TEST_ENV, "<TEST_ENV>"),
      memory_type: input.memory_type,
      load_reason: input.load_reason,
      trigger_file_path: input.trigger_file_path?.replace(TEST_ENV, "<TEST_ENV>"),
      parent_file_path: input.parent_file_path?.replace(TEST_ENV, "<TEST_ENV>"),
    });
  }
  return {};
};

const toolUseHook: HookCallback = async (input) => {
  if (input.hook_event_name === "PreToolUse") {
    const toolInput = input.tool_input as Record<string, unknown>;
    const cleanedInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(toolInput)) {
      cleanedInput[k] = typeof v === "string" ? v.replace(TEST_ENV, "<TEST_ENV>").replace(PROJECT_ROOT, "<project_root>") : v;
    }
    record("TOOL_USE", { tool_name: input.tool_name, tool_input: cleanedInput });
  }
  return {};
};

const compactHook: HookCallback = async (input) => {
  if (input.hook_event_name === "PreCompact") {
    record("COMPACT", { phase: "pre", trigger: input.trigger, custom_instructions: input.custom_instructions });
  }
  if (input.hook_event_name === "PostCompact") {
    record("COMPACT", { phase: "post", trigger: input.trigger, summary_length: input.compact_summary.length });
  }
  return {};
};

const hooks = {
  InstructionsLoaded: [{ matcher: ".*", hooks: [instructionsLoadedHook] }],
  PreToolUse: [{ matcher: ".*", hooks: [toolUseHook] }],
  PreCompact: [{ matcher: ".*", hooks: [compactHook] }],
  PostCompact: [{ matcher: ".*", hooks: [compactHook] }],
};

const MARKERS = ["ROOT_INSTRUCTIONS_ACTIVE", "SRC_INSTRUCTIONS_ACTIVE", "TESTS_INSTRUCTIONS_ACTIVE", "DOCS_INSTRUCTIONS_ACTIVE"];

function findMarkersInResponse(text: string): string[] {
  return MARKERS.filter((m) => text.includes(m));
}

async function runScenario(name: string, prompt: string, resume?: string): Promise<{ text: string; sessionId: string }> {
  currentScenario = name;
  console.log(`\n${"═".repeat(70)}`);
  console.log(`SCENARIO: ${name}`);
  console.log(`PROMPT: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`);
  console.log("─".repeat(70));

  let fullText = "";
  let sessionId = "";

  const options: Parameters<typeof query>[0]["options"] = {
    cwd: TEST_ENV,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Bash"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["project"],
    hooks,
    maxTurns: 20,
  };

  if (resume) {
    options.resume = resume;
  }

  for await (const msg of query({ prompt, options })) {
    if ("type" in msg && msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
      sessionId = (msg as { session_id?: string }).session_id ?? "";
      record("SESSION_START", { session_id: sessionId, resume: resume ?? null });
    }
    if ("result" in msg) {
      fullText = msg.result ?? "";
    }
  }

  const markers = findMarkersInResponse(fullText);
  record("RESPONSE_MARKERS", { found: markers });

  console.log(`  Session: ${sessionId}`);
  console.log(`  Markers: ${markers.length ? markers.join(", ") : "(none)"}`);

  return { text: fullText, sessionId };
}

// ─── Generate large context to trigger compaction ─────────────────────────

function generateLargeSystemPrompt(): string {
  // Generate ~50K chars of filler text for the prompt context
  const paragraph = "This is filler text to fill up the context window for testing compaction behavior. " +
    "We need to generate enough tokens to potentially trigger auto-compaction. ".repeat(3);
  const block = paragraph.repeat(50);
  return block.repeat(10);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("Experiment 2: Deep dive into CLAUDE.md state and compaction");
  console.log(`Test environment: ${TEST_ENV}`);

  // ── Scenario A: SAME file accessed TWICE in same session ───────────────
  // Question: Does re-reading the EXACT same file trigger another CLAUDE.md load?
  const sA1 = await runScenario(
    "A1_first_read_same_file",
    "Read src/main.py and tell me what the add() function returns when given 2 and 3."
  );
  const sA2 = await runScenario(
    "A2_second_read_same_file",
    "Read src/main.py again and tell me what the multiply() function returns when given 4 and 5.",
    sA1.sessionId
  );

  // ── Scenario B: Glob THEN Read in same session ─────────────────────────
  // Question: Does Glob trigger CLAUDE.md load? What about subsequent Read?
  const sB1 = await runScenario(
    "B1_glob_first",
    "Use glob to find all .py files in src/. Just list the paths."
  );
  const sB2 = await runScenario(
    "B2_read_after_glob",
    "Now read src/main.py and summarize it.",
    sB1.sessionId
  );

  // ── Scenario C: Read THEN Glob in same session ─────────────────────────
  const sC1 = await runScenario(
    "C1_read_first",
    "Read src/main.py and summarize it."
  );
  const sC2 = await runScenario(
    "C2_glob_after_read",
    "Now use glob to find all .py files in src/.",
    sC1.sessionId
  );

  // ── Scenario D: Compaction test ────────────────────────────────────────
  // Build a long conversation to get near context limit, then check CLAUDE.md behavior.
  // We'll send many turns with large content to fill context.
  const compactionPrompt = `Read src/main.py. Then write me an extremely detailed analysis of every single aspect of this file - the coding style, the function signatures, the return types, the naming conventions, edge cases, potential bugs, performance characteristics, memory usage, thread safety, error handling, testability, maintainability, and anything else you can think of. Be as verbose and comprehensive as possible, I want at least 500 words.`;

  const sD1 = await runScenario("D1_compaction_setup_1", compactionPrompt);
  const sD2 = await runScenario(
    "D2_compaction_setup_2",
    "Now do the same extremely detailed analysis but this time focus on how this code could be improved. Write at least 500 words about potential improvements, refactoring opportunities, design patterns that could be applied, and alternative implementations.",
    sD1.sessionId
  );
  const sD3 = await runScenario(
    "D3_compaction_setup_3",
    "Now analyze src/utils.py with the same depth. At least 500 words about every aspect of the file.",
    sD2.sessionId
  );
  const sD4 = await runScenario(
    "D4_after_much_context_access_tests",
    "Now read tests/test_main.py and tell me what tests it has.",
    sD3.sessionId
  );

  // ── Scenario E: Check if Bash tool can indirectly trigger CLAUDE.md ────
  // Use bash to read a file (not the Read tool)
  const sE = await runScenario(
    "E_bash_read_file",
    "Use bash to run: cat src/main.py"
  );

  // ── Scenario F: Check if Write (without prior Read) triggers load ──────
  const sF = await runScenario(
    "F_write_without_read",
    "Create a new file src/constants.py with content: PI = 3.14159"
  );

  // ── Save results ───────────────────────────────────────────────────────
  const results = { timestamp: new Date().toISOString(), events: allEvents };
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

  // ── Print summary ──────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(70)}`);
  console.log("EXPERIMENT 2 COMPLETE");

  const loadEvents = allEvents.filter((e) => e.type === "INSTRUCTIONS_LOADED");
  const byScenario: Record<string, typeof loadEvents> = {};
  for (const e of loadEvents) {
    (byScenario[e.scenario] ??= []).push(e);
  }

  console.log("\n── CLAUDE.md LOADS BY SCENARIO ──────────────────────────────────────");
  for (const [scenario, loads] of Object.entries(byScenario)) {
    console.log(`\n  ${scenario}:`);
    for (const l of loads) {
      console.log(`    → ${l.data.file_path} [${l.data.load_reason}]`);
    }
  }

  // Check compaction events
  const compactEvents = allEvents.filter((e) => e.type === "COMPACT");
  console.log(`\n── COMPACTION EVENTS: ${compactEvents.length} ─────────────────────────────────────`);
  for (const e of compactEvents) {
    console.log(`  ${e.scenario}: phase=${e.data.phase} trigger=${e.data.trigger}`);
  }

  console.log("\n── KEY FINDINGS ──────────────────────────────────────────────────────");

  const a1SrcLoad = byScenario["A1_first_read_same_file"]?.some((l) => String(l.data.file_path).includes("src/CLAUDE"));
  const a2SrcLoad = byScenario["A2_second_read_same_file"]?.some((l) => String(l.data.file_path).includes("src/CLAUDE"));
  console.log(`\n  Q: Same file read twice (same session) - CLAUDE.md loaded each time?`);
  console.log(`  A1 load: ${a1SrcLoad ? "YES" : "NO"} | A2 load: ${a2SrcLoad ? "YES" : "NO"}`);

  const b1Load = byScenario["B1_glob_first"]?.some((l) => String(l.data.file_path).includes("src/CLAUDE"));
  const b2Load = byScenario["B2_read_after_glob"]?.some((l) => String(l.data.file_path).includes("src/CLAUDE"));
  console.log(`\n  Q: Glob doesn't load CLAUDE.md, but subsequent Read does?`);
  console.log(`  B1 (glob): src/CLAUDE.md loaded = ${b1Load ? "YES" : "NO"}`);
  console.log(`  B2 (read after glob): src/CLAUDE.md loaded = ${b2Load ? "YES" : "NO"}`);

  const d4TestsLoad = byScenario["D4_after_much_context_access_tests"]?.some((l) => String(l.data.file_path).includes("tests/CLAUDE"));
  const hadCompaction = compactEvents.length > 0;
  console.log(`\n  Q: After heavy context usage (compaction scenario), does tests/CLAUDE.md load?`);
  console.log(`  Compaction occurred: ${hadCompaction ? "YES" : "NO"}`);
  console.log(`  tests/CLAUDE.md loaded in D4: ${d4TestsLoad ? "YES" : "NO"}`);

  const eBashLoad = byScenario["E_bash_read_file"]?.some((l) => String(l.data.file_path).includes("src/CLAUDE"));
  console.log(`\n  Q: Does 'bash cat file' (vs Read tool) trigger src/CLAUDE.md load?`);
  console.log(`  A: ${eBashLoad ? "YES" : "NO"}`);

  const fWriteLoad = byScenario["F_write_without_read"]?.some((l) => String(l.data.file_path).includes("src/CLAUDE"));
  console.log(`\n  Q: Does Write (create new file in src/) trigger src/CLAUDE.md load?`);
  console.log(`  A: ${fWriteLoad ? "YES" : "NO"}`);

  console.log(`\nResults saved to: ${RESULTS_FILE}`);
}

main().catch(console.error);
