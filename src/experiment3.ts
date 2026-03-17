/**
 * Experiment 3: Token counting via proxy interception.
 *
 * Runs a local HTTP proxy that logs every /v1/messages call — system prompt
 * size, CLAUDE.md marker occurrences (to see if content is re-injected),
 * and input/output token counts.
 *
 * Key questions answered:
 *   - Is CLAUDE.md content actually injected into system prompt, or messages?
 *   - Does it appear multiple times when accessed repeatedly?
 *   - How much do tokens grow with each new subdir CLAUDE.md loaded?
 */

import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync } from "fs";
import { resolve } from "path";
import { startProxy, setLabel, getProxyLogs, PROXY_PORT } from "./proxy.js";

const TEST_ENV = resolve(new URL(".", import.meta.url).pathname, "../test-env");
const RESULTS_FILE = resolve(new URL(".", import.meta.url).pathname, "../results3.json");

// ─── Tracing ───────────────────────────────────────────────────────────────

interface ScenarioResult {
  name: string;
  sessionId: string;
  instructionsLoaded: Array<{ file: string; reason: string }>;
  apiCalls: number;
}

const results: ScenarioResult[] = [];
let currentScenario = "init";
const instructionsLoadedThisScenario: Array<{ file: string; reason: string }> = [];

const instructionsHook: HookCallback = async (input) => {
  if (input.hook_event_name === "InstructionsLoaded") {
    instructionsLoadedThisScenario.push({
      file: input.file_path.replace(TEST_ENV, "<TEST_ENV>"),
      reason: input.load_reason,
    });
  }
  return {};
};

const hooks = {
  InstructionsLoaded: [{ matcher: ".*", hooks: [instructionsHook] }],
};

// ─── Runner ────────────────────────────────────────────────────────────────

async function runScenario(name: string, prompt: string, resume?: string): Promise<string> {
  currentScenario = name;
  instructionsLoadedThisScenario.length = 0;

  setLabel(name);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`▶ SCENARIO: ${name}`);
  console.log(`  ${prompt.slice(0, 90)}${prompt.length > 90 ? "…" : ""}`);

  const proxyCallsBefore = getProxyLogs().length;
  let sessionId = "";

  const options: Parameters<typeof query>[0]["options"] = {
    cwd: TEST_ENV,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Bash"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["project"],
    hooks,
    maxTurns: 10,
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${PROXY_PORT}`, CLAUDECODE: undefined } as NodeJS.ProcessEnv,
    stderr: (line: string) => process.stderr.write(`[claude stderr] ${line}`),
  };

  if (resume) options.resume = resume;

  for await (const msg of query({ prompt, options })) {
    if ("type" in msg && msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
      sessionId = (msg as { session_id?: string }).session_id ?? "";
    }
  }

  const proxyCallsAfter = getProxyLogs().length;
  const newCalls = getProxyLogs().slice(proxyCallsBefore);

  results.push({
    name,
    sessionId,
    instructionsLoaded: [...instructionsLoadedThisScenario],
    apiCalls: proxyCallsAfter - proxyCallsBefore,
  });

  return sessionId;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const proxy = startProxy();
  // Give proxy a moment to bind
  await new Promise((r) => setTimeout(r, 200));

  console.log("\n═══ Experiment 3: Token counting via proxy interception ═══════════════");
  console.log(`Test env: ${TEST_ENV}`);
  console.log(`Proxy: http://127.0.0.1:${PROXY_PORT}`);

  // ── CLAUDE.md instructs agent to read b.md after any src/ file ──────────
  // src/CLAUDE.md says: "after reading any src/ file, MUST also read src/b.md"
  // Expected: read a.md → inject src/CLAUDE.md → agent reads b.md → inject src/CLAUDE.md again → src×2
  const s7 = await runScenario(
    "7_chained_read_via_claudemd",
    "Read src/a.md and tell me what it says."
  );

  // ── Stop proxy and collect results ──────────────────────────────────────
  proxy.close();

  const allProxyLogs = getProxyLogs();

  // Build per-scenario proxy logs
  const proxyByScenario: Record<string, typeof allProxyLogs> = {};
  for (const log of allProxyLogs) {
    (proxyByScenario[log.label] ??= []).push(log);
  }

  // ── Print analysis ───────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(70)}`);
  console.log("TOKEN AND INJECTION ANALYSIS");
  console.log("═".repeat(70));

  console.log("\n── Per-scenario API call breakdown ─────────────────────────────────────");
  for (const [label, logs] of Object.entries(proxyByScenario)) {
    console.log(`\n  ${label}:`);
    for (const l of logs) {
      const sysMarkers = Object.entries(l.system_claude_md_counts ?? {});
      const msgMarkers = Object.entries(l.all_content_claude_md_counts ?? {});
      console.log(
        `    call #${l.id}: sys=${l.system_chars}ch | msgs=${l.message_count} | ` +
        `in=${l.input_tokens ?? "?"} out=${l.output_tokens ?? "?"} tokens`
      );
      if (sysMarkers.length > 0) {
        console.log(`      → system prompt CLAUDE.md markers: ${sysMarkers.map(([k, v]) => `${k}×${v}`).join(", ")}`);
      }
      if (msgMarkers.length > 0) {
        console.log(`      → messages CLAUDE.md markers: ${msgMarkers.map(([k, v]) => `${k}×${v}`).join(", ")}`);
      }
    }
  }

  // Key comparison: does token count grow on repeated same-subdir access?
  console.log("\n── KEY COMPARISON: Token growth across repeated src/ accesses ───────────");
  const firstRead = proxyByScenario["1_first_read_src"]?.at(-1);
  const secondRead = proxyByScenario["2_second_read_src_same_session"]?.at(-1);
  const thirdRead = proxyByScenario["3_third_read_src_same_session"]?.at(-1);

  if (firstRead && secondRead) {
    console.log(`  1st access to src/: ${firstRead.input_tokens ?? "?"} input tokens (sys=${firstRead.system_chars}ch)`);
    console.log(`  2nd access to src/: ${secondRead.input_tokens ?? "?"} input tokens (sys=${secondRead.system_chars}ch)`);
    if (thirdRead) {
      console.log(`  3rd access to src/: ${thirdRead.input_tokens ?? "?"} input tokens (sys=${thirdRead.system_chars}ch)`);
    }

    const growth1to2 = (secondRead.input_tokens ?? 0) - (firstRead.input_tokens ?? 0);
    console.log(`\n  Token growth 1st→2nd: ${growth1to2 > 0 ? "+" : ""}${growth1to2}`);
    if (growth1to2 > 100) {
      console.log(`  ⚠️  Significant growth → CLAUDE.md content IS being re-injected each time`);
    } else {
      console.log(`  ✓  Minimal growth → CLAUDE.md content is NOT re-injected (deduplicated)`);
    }
  }

  // Check where CLAUDE.md content ends up (system vs messages)
  console.log("\n── WHERE does CLAUDE.md content appear? ────────────────────────────────");
  for (const log of allProxyLogs) {
    const hasSysMarkers = Object.keys(log.system_claude_md_counts ?? {}).length > 0;
    const hasMsgMarkers = Object.keys(log.all_content_claude_md_counts ?? {}).length > 0;
    if (hasSysMarkers || hasMsgMarkers) {
      console.log(
        `  [${log.label} #${log.id}] sys=${hasSysMarkers ? "YES" : "no"} | msgs=${hasMsgMarkers ? "YES" : "no"}`
      );
    }
  }

  // Chained read via CLAUDE.md instruction
  console.log("\n── CHAINED READ: CLAUDE.md instructs agent to read b.md after any src/ file ──");
  const chainedReads = proxyByScenario["7_chained_read_via_claudemd"] ?? [];
  for (const l of chainedReads) {
    const msgMarkers = Object.entries(l.all_content_claude_md_counts ?? {});
    const markerStr = msgMarkers.length > 0 ? msgMarkers.map(([k, v]) => `${k}×${v}`).join(", ") : "none";
    console.log(`  call #${l.id}: msgs=${l.message_count} | ${markerStr}`);
  }

  // Multi-read accumulation check
  console.log("\n── ACCUMULATED INJECTIONS: multiple src/ reads in one session ───────────");
  const multiReads = proxyByScenario["6_multi_read_src_single_session"] ?? [];
  for (const l of multiReads) {
    const msgMarkers = Object.entries(l.all_content_claude_md_counts ?? {});
    const markerStr = msgMarkers.length > 0 ? msgMarkers.map(([k, v]) => `${k}×${v}`).join(", ") : "none";
    console.log(`  call #${l.id}: msgs=${l.message_count} | ${markerStr}`);
  }

  // Growing system prompt comparison (multi-subdir)
  console.log("\n── SYSTEM PROMPT GROWTH as more subdirs are accessed ───────────────────");
  const ma = proxyByScenario["5a_read_src"]?.at(-1);
  const mb = proxyByScenario["5b_read_tests_same_session"]?.at(-1);
  const mc = proxyByScenario["5c_read_docs_same_session"]?.at(-1);
  if (ma) console.log(`  After loading src/CLAUDE.md:   sys=${ma.system_chars}ch | in=${ma.input_tokens ?? "?"} tokens`);
  if (mb) console.log(`  After loading tests/CLAUDE.md: sys=${mb.system_chars}ch | in=${mb.input_tokens ?? "?"} tokens`);
  if (mc) console.log(`  After loading docs/CLAUDE.md:  sys=${mc.system_chars}ch | in=${mc.input_tokens ?? "?"} tokens`);

  // Save results
  writeFileSync(RESULTS_FILE, JSON.stringify({ results, proxyLogs: allProxyLogs }, null, 2));
  console.log(`\nResults saved to: ${RESULTS_FILE}`);
}

main().catch(console.error);
