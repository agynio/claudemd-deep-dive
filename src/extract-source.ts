/**
 * Extracts and logs the relevant source code snippets from cli.js
 * that implement the CLAUDE.md injection mechanism.
 * Output: results-source.json
 */

import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { resolve } from "path";

const require = createRequire(import.meta.url);
const pkgDir = resolve(require.resolve("@anthropic-ai/claude-agent-sdk"), "..");
const CLI_JS = resolve(pkgDir, "cli.js");

const content = readFileSync(CLI_JS, "utf8");

function extractAround(label: string, search: string, before = 300, after = 400): {
  label: string;
  offset: number;
  snippet: string;
} {
  const offset = content.indexOf(search);
  if (offset === -1) return { label, offset: -1, snippet: "(not found)" };
  const snippet = content.slice(Math.max(0, offset - before), offset + after);
  return { label, offset, snippet };
}

// 1. lJ7 — wraps content in <system-reminder>
const lJ7 = extractAround(
  "lJ7 — wraps CLAUDE.md content in <system-reminder>",
  "function lJ7("
);

// 2. _B9 — retrieves stored CLAUDE.md content and calls lJ7
const _B9 = extractAround(
  "_B9 — retrieves stored CLAUDE.md and calls lJ7",
  "function _B9("
);

// 3. Call site — where _B9 is prepended to the file content in the Read tool result
const callSite = extractAround(
  "Call site — _B9(A) prepended to file content in Read tool result",
  "_B9(A)+qB9(A.file)",
  400,
  300
);

// 4. readFileState reference — deduplication check in the Read tool
const readFileState = extractAround(
  "readFileState — deduplication Map used by Read tool",
  "{readFileState:O,fileReadingLimits:$}",
  100,
  500
);

// 5. InstructionsLoaded hook schema — load_reason enum values
const hookSchema = extractAround(
  "InstructionsLoaded hook schema — load_reason enum",
  '"session_start","nested_traversal"',
  50,
  300
);

const output = {
  timestamp: new Date().toISOString(),
  cli_js_path: CLI_JS,
  description:
    "Source code evidence for the CLAUDE.md injection mechanism in @anthropic-ai/claude-agent-sdk",
  findings: [lJ7, _B9, callSite, readFileState, hookSchema],
};

writeFileSync("results-source.json", JSON.stringify(output, null, 2));
console.log("Wrote results-source.json");
console.log(`Extracted ${output.findings.length} snippets from ${CLI_JS}`);
