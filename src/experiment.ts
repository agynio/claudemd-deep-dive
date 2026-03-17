/**
 * Experiment: How does Claude Code read CLAUDE.md files in subdirectories?
 *
 * We use InstructionsLoaded, PreToolUse/PostToolUse, PreCompact/PostCompact hooks
 * to trace when/why CLAUDE.md files are read.
 */

import { query, type HookCallback, type HookInput } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync } from "fs";
import { join, resolve } from "path";

const TEST_ENV = resolve(new URL(".", import.meta.url).pathname, "../test-env");
const RESULTS_FILE = resolve(new URL(".", import.meta.url).pathname, "../results.json");

// ─── Tracing infrastructure ────────────────────────────────────────────────

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
    console.log(`${prefix} ${data.tool_name} | ${JSON.stringify(data.tool_input).slice(0, 80)}`);
  } else if (type === "COMPACT") {
    console.log(`${prefix} trigger=${data.trigger}`);
  } else if (type === "RESPONSE_MARKERS") {
    console.log(`${prefix} ${JSON.stringify(data.found)}`);
  }
}

// ─── Hooks ─────────────────────────────────────────────────────────────────

const instructionsLoadedHook: HookCallback = async (input) => {
  if (input.hook_event_name === "InstructionsLoaded") {
    record("INSTRUCTIONS_LOADED", {
      file_path: input.file_path.replace(TEST_ENV, "<TEST_ENV>"),
      memory_type: input.memory_type,
      load_reason: input.load_reason,
      trigger_file_path: input.trigger_file_path?.replace(TEST_ENV, "<TEST_ENV>"),
      parent_file_path: input.parent_file_path?.replace(TEST_ENV, "<TEST_ENV>"),
      globs: input.globs,
    });
  }
  return {};
};

const toolUseHook: HookCallback = async (input) => {
  if (input.hook_event_name === "PreToolUse") {
    const toolInput = input.tool_input as Record<string, unknown>;
    // Shorten file paths for readability
    const cleanedInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(toolInput)) {
      cleanedInput[k] = typeof v === "string" ? v.replace(TEST_ENV, "<TEST_ENV>") : v;
    }
    record("TOOL_USE", { tool_name: input.tool_name, tool_input: cleanedInput });
  }
  return {};
};

const compactHook: HookCallback = async (input) => {
  if (input.hook_event_name === "PreCompact") {
    record("COMPACT", { phase: "pre", trigger: input.trigger });
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

// ─── Helpers ───────────────────────────────────────────────────────────────

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
    settingSources: ["project"],  // Enable project CLAUDE.md loading
    hooks,
    maxTurns: 15,
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
  record("RESPONSE_MARKERS", { found: markers, text_length: fullText.length });

  console.log(`\nRESULT SUMMARY:`);
  console.log(`  Session: ${sessionId}`);
  console.log(`  Markers in response: ${markers.length ? markers.join(", ") : "(none)"}`);

  return { text: fullText, sessionId };
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

async function main() {
  console.log("Claude Code CLAUDE.md On-Demand Reading Experiment");
  console.log(`Test environment: ${TEST_ENV}`);
  console.log(`Results will be saved to: ${RESULTS_FILE}`);

  // ── Scenario 1: First access to src/ ──────────────────────────────────
  // Question: Does reading a file in src/ trigger loading of src/CLAUDE.md?
  // Expected load_reason: 'nested_traversal'
  const s1 = await runScenario(
    "1_first_access_src",
    "Read the file src/main.py and tell me briefly what functions it defines."
  );

  // ── Scenario 2: Second access to src/ in SAME session ─────────────────
  // Question: Is src/CLAUDE.md loaded again, or does it have state?
  const s2 = await runScenario(
    "2_second_access_src_same_session",
    "Now read src/utils.py and tell me what functions it defines.",
    s1.sessionId
  );

  // ── Scenario 3: Access src/ in a NEW session ───────────────────────────
  // Question: Does it re-read src/CLAUDE.md in a fresh session?
  const s3 = await runScenario(
    "3_new_session_access_src",
    "Read the file src/main.py and tell me briefly what functions it defines."
  );

  // ── Scenario 4: Access MULTIPLE subdirs in one prompt ─────────────────
  // Question: Does it load each subdir's CLAUDE.md separately?
  const s4 = await runScenario(
    "4_multiple_subdirs",
    "Read src/main.py, tests/test_main.py, and docs/README.md. Briefly summarize each."
  );

  // ── Scenario 5: Modification (Write) to src/ ──────────────────────────
  // Question: Does WRITING to a file also trigger subdir CLAUDE.md loading?
  const s5 = await runScenario(
    "5_write_to_src",
    "Add a module-level docstring '\"\"\"Math utility functions.\"\"\"' at the very top of src/main.py, before any existing code."
  );

  // ── Scenario 6: No tool use (pure chat) ───────────────────────────────
  // Question: Does CLAUDE.md load without any file access?
  const s6 = await runScenario(
    "6_no_file_access",
    "What is 2 + 2? Answer with just the number."
  );

  // ── Scenario 7: Session resume after gap ──────────────────────────────
  // Resume scenario 3's session and access tests/
  // Question: After resuming, does it load new subdir CLAUDE.md on first access?
  const s7 = await runScenario(
    "7_resumed_session_new_subdir",
    "Now read tests/test_main.py and tell me what test functions it has.",
    s3.sessionId
  );

  // ── Scenario 8: Glob (does glob in subdir trigger load?) ───────────────
  const s8 = await runScenario(
    "8_glob_in_subdir",
    "Use glob to list all .py files inside the src/ directory."
  );

  // ── Scenario 9: Bash cd into subdir ────────────────────────────────────
  const s9 = await runScenario(
    "9_bash_cd_subdir",
    "Run the bash command: cd src && cat main.py"
  );

  // ── Save results ───────────────────────────────────────────────────────
  const results = {
    timestamp: new Date().toISOString(),
    test_env: TEST_ENV,
    events: allEvents,
    summary: buildSummary(),
  };

  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

  console.log(`\n${"═".repeat(70)}`);
  console.log("EXPERIMENT COMPLETE");
  console.log(`Results saved to: ${RESULTS_FILE}`);
  printSummary();
}

// ─── Summary ───────────────────────────────────────────────────────────────

function buildSummary() {
  const loadEvents = allEvents.filter((e) => e.type === "INSTRUCTIONS_LOADED");
  const byScenario: Record<string, Array<{ file: unknown; reason: unknown; trigger: unknown }>> = {};

  for (const e of loadEvents) {
    if (!byScenario[e.scenario]) byScenario[e.scenario] = [];
    byScenario[e.scenario].push({
      file: e.data.file_path,
      reason: e.data.load_reason,
      trigger: e.data.trigger_file_path,
    });
  }

  const markerEvents = allEvents.filter((e) => e.type === "RESPONSE_MARKERS");
  const markersByScenario: Record<string, unknown[]> = {};
  for (const e of markerEvents) {
    markersByScenario[e.scenario] = e.data.found as unknown[];
  }

  return { loads_by_scenario: byScenario, markers_by_scenario: markersByScenario };
}

function printSummary() {
  const summary = buildSummary();

  console.log("\n── CLAUDE.md LOADS BY SCENARIO ──────────────────────────────────────");
  for (const [scenario, loads] of Object.entries(summary.loads_by_scenario)) {
    console.log(`\n  ${scenario}:`);
    if (loads.length === 0) {
      console.log("    (none)");
    } else {
      for (const l of loads) {
        console.log(`    → ${l.file} [${l.reason}]${l.trigger ? ` triggered by ${l.trigger}` : ""}`);
      }
    }
  }

  console.log("\n── MARKER PHRASES IN RESPONSES ──────────────────────────────────────");
  for (const [scenario, markers] of Object.entries(summary.markers_by_scenario)) {
    const arr = markers as string[];
    console.log(`  ${scenario}: ${arr.length ? arr.join(", ") : "(none)"}`);
  }

  console.log("\n── KEY FINDINGS ──────────────────────────────────────────────────────");
  const loads = summary.loads_by_scenario;

  const s1Loads = loads["1_first_access_src"] ?? [];
  const s2Loads = loads["2_second_access_src_same_session"] ?? [];
  const s3Loads = loads["3_new_session_access_src"] ?? [];

  console.log(`\n  Q1: Does reading src/main.py trigger src/CLAUDE.md load?`);
  const srcLoad = s1Loads.find((l) => String(l.file).includes("/src/CLAUDE.md"));
  console.log(`  A: ${srcLoad ? `YES (reason: ${srcLoad.reason})` : "NO"}`);

  console.log(`\n  Q2: Does 2nd access to src/ in SAME session re-load src/CLAUDE.md?`);
  const s2SrcLoad = s2Loads.find((l) => String(l.file).includes("/src/CLAUDE.md"));
  console.log(`  A: ${s2SrcLoad ? "YES (loaded again)" : "NO (not loaded again - has state)"}`);

  console.log(`\n  Q3: Does a NEW session re-read src/CLAUDE.md?`);
  const s3SrcLoad = s3Loads.find((l) => String(l.file).includes("/src/CLAUDE.md"));
  console.log(`  A: ${s3SrcLoad ? "YES (fresh load on new session)" : "NO"}`);

  const s4Loads = loads["4_multiple_subdirs"] ?? [];
  const distinctDirs = new Set(s4Loads.map((l) => String(l.file).split("/").at(-2)));
  console.log(`\n  Q4: Multiple subdirs in one prompt - distinct dir CLAUDE.mds loaded?`);
  console.log(`  A: ${s4Loads.length} loads across dirs: ${[...distinctDirs].join(", ") || "(none)"}`);

  const s6Loads = loads["6_no_file_access"] ?? [];
  console.log(`\n  Q5: Does pure chat (no file access) trigger any CLAUDE.md loads?`);
  console.log(`  A: ${s6Loads.length > 0 ? `YES - ${s6Loads.length} load(s)` : "NO"}`);
}

main().catch(console.error);
