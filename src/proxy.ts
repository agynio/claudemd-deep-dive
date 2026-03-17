/**
 * Intercepting proxy for Anthropic API calls.
 *
 * Receives HTTP from Claude Code (ANTHROPIC_BASE_URL=http://localhost:PORT),
 * forwards to real Anthropic HTTPS API, logs:
 *   - Each /v1/messages request: system prompt size, message count,
 *     CLAUDE.md marker occurrences, token estimates
 *   - Each response: input_tokens, output_tokens, stop_reason
 *
 * Usage: run in background, set ANTHROPIC_BASE_URL in the experiment env.
 */

import http from "http";
import https from "https";
import { URL } from "url";
import { writeFileSync, appendFileSync } from "fs";
import { resolve } from "path";

// Save first N full request/response bodies for deep inspection
const MAX_FULL_BODY_SAVES = 999;
let fullBodySaveCount = 0;
const FULL_BODIES_FILE = resolve(new URL(".", import.meta.url).pathname, "../proxy.bodies.jsonl");

export const PROXY_PORT = 9877;
const ANTHROPIC_API_HOST = "api.anthropic.com";

const LOG_FILE = resolve(new URL(".", import.meta.url).pathname, "../proxy.log.json");

// Clear log file on start
writeFileSync(LOG_FILE, "");

// Markers we care about (from CLAUDE.md files)
const CLAUDE_MD_MARKERS = [
  { marker: "PROJECT_ROOT_LOADED", label: "root/CLAUDE.md" },
  { marker: "SRC_DIR_LOADED", label: "src/CLAUDE.md" },
  { marker: "TESTS_DIR_LOADED", label: "tests/CLAUDE.md" },
  { marker: "DOCS_DIR_LOADED", label: "docs/CLAUDE.md" },
];

let requestCount = 0;
let currentLabel = "unknown";

export function setLabel(label: string) {
  currentLabel = label;
}

interface RequestLog {
  id: number;
  ts: string;
  label: string;
  path: string;
  // For /v1/messages
  model?: string;
  system_chars?: number;
  system_claude_md_counts?: Record<string, number>;
  message_count?: number;
  messages_chars?: number;
  all_content_claude_md_counts?: Record<string, number>;
  // Response
  input_tokens?: number;
  output_tokens?: number;
  stop_reason?: string;
  status?: number;
  error?: string;
}

const allLogs: RequestLog[] = [];

function countOccurrences(text: string, marker: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(marker, idx)) !== -1) {
    count++;
    idx += marker.length;
  }
  return count;
}

function analyzeBody(body: string, log: RequestLog) {
  try {
    const parsed = JSON.parse(body);

    log.model = parsed.model;

    // Analyze system prompt
    let systemText = "";
    if (typeof parsed.system === "string") {
      systemText = parsed.system;
    } else if (Array.isArray(parsed.system)) {
      systemText = parsed.system.map((b: { text?: string }) => b.text ?? "").join("\n");
    }
    log.system_chars = systemText.length;
    log.system_claude_md_counts = {};
    for (const { marker, label } of CLAUDE_MD_MARKERS) {
      const count = countOccurrences(systemText, marker);
      if (count > 0) log.system_claude_md_counts[label] = count;
    }

    // Analyze messages
    if (Array.isArray(parsed.messages)) {
      log.message_count = parsed.messages.length;
      const allMsgText = JSON.stringify(parsed.messages);
      log.messages_chars = allMsgText.length;
      log.all_content_claude_md_counts = {};
      for (const { marker, label } of CLAUDE_MD_MARKERS) {
        const count = countOccurrences(allMsgText, marker);
        if (count > 0) log.all_content_claude_md_counts[label] = count;
      }
    }
  } catch {
    log.error = "failed to parse body";
  }
}

function analyzeResponse(body: string, log: RequestLog) {
  try {
    const parsed = JSON.parse(body);
    if (parsed.usage) {
      log.input_tokens = parsed.usage.input_tokens;
      log.output_tokens = parsed.usage.output_tokens;
    }
    log.stop_reason = parsed.stop_reason;
  } catch {
    // streaming or parse error — ignore
  }
}

export function startProxy(): http.Server {
  writeFileSync(FULL_BODIES_FILE, "");

  const server = http.createServer((clientReq, clientRes) => {
    const id = ++requestCount;
    const log: RequestLog = {
      id,
      ts: new Date().toISOString(),
      label: currentLabel,
      path: clientReq.url ?? "/",
    };

    const chunks: Buffer[] = [];
    clientReq.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

    clientReq.on("end", () => {
      const requestBody = Buffer.concat(chunks);
      const requestBodyStr = requestBody.toString("utf8");

      const isMessages = clientReq.url?.includes("/v1/messages") && clientReq.method === "POST";
      if (isMessages) {
        analyzeBody(requestBodyStr, log);
        // Save full body for inspection
        if (fullBodySaveCount < MAX_FULL_BODY_SAVES) {
          fullBodySaveCount++;
          appendFileSync(FULL_BODIES_FILE, JSON.stringify({ id, label: currentLabel, request: JSON.parse(requestBodyStr) }) + "\n");
        }
      }

      // Forward to real Anthropic API
      const targetUrl = new URL(`https://${ANTHROPIC_API_HOST}${clientReq.url}`);
      // Strip accept-encoding so the API returns uncompressed text (not gzip),
      // which lets us regex-search the raw SSE body for token counts.
      const forwardHeaders = { ...clientReq.headers, host: ANTHROPIC_API_HOST };
      delete (forwardHeaders as Record<string, unknown>)["accept-encoding"];

      const options: https.RequestOptions = {
        hostname: targetUrl.hostname,
        path: targetUrl.pathname + targetUrl.search,
        method: clientReq.method,
        headers: forwardHeaders,
      };

      const apiReq = https.request(options, (apiRes) => {
        log.status = apiRes.statusCode;
        clientRes.writeHead(apiRes.statusCode ?? 200, apiRes.headers);

        const responseChunks: Buffer[] = [];
        apiRes.on("data", (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseChunks.push(buf);
          clientRes.write(buf);
        });

        apiRes.on("end", () => {
          clientRes.end();
          const responseBodyStr = Buffer.concat(responseChunks).toString("utf8");
          if (isMessages) {
            // Try non-streaming JSON first
            analyzeResponse(responseBodyStr, log);
            // For SSE streaming: find message_delta or message_start usage block
            // message_start has full input_tokens; message_delta has output_tokens
            if (log.input_tokens === undefined) {
              // Extract from message_start: {"type":"message","usage":{"input_tokens":N,...}}
              const startMatch = responseBodyStr.match(/"input_tokens":(\d+)/);
              if (startMatch) log.input_tokens = parseInt(startMatch[1]);
            }
            if (log.output_tokens === undefined) {
              // Extract from message_delta: {"output_tokens":N}
              // Find LAST occurrence (cumulative)
              const allMatches = [...responseBodyStr.matchAll(/"output_tokens":(\d+)/g)];
              if (allMatches.length > 0) {
                log.output_tokens = parseInt(allMatches.at(-1)![1]);
              }
            }
          }
          finalize(log);
        });
      });

      apiReq.on("error", (err) => {
        log.error = err.message;
        clientRes.writeHead(502);
        clientRes.end(JSON.stringify({ error: err.message }));
        finalize(log);
      });

      apiReq.write(requestBody);
      apiReq.end();
    });
  });

  server.listen(PROXY_PORT, "127.0.0.1", () => {
    console.log(`[proxy] Listening on http://127.0.0.1:${PROXY_PORT}`);
  });

  return server;
}

function finalize(log: RequestLog) {
  allLogs.push(log);
  // Only log /v1/messages calls (skip token counting, file list, etc.)
  if (!log.path.includes("/v1/messages")) return;

  const sysMarkers = Object.entries(log.system_claude_md_counts ?? {});
  const msgMarkers = Object.entries(log.all_content_claude_md_counts ?? {});

  console.log(
    `[proxy #${log.id}] ${log.label} | model=${log.model} | ` +
    `sys=${log.system_chars}ch | msgs=${log.message_count} | ` +
    `in=${log.input_tokens ?? "?"} out=${log.output_tokens ?? "?"} tokens | ` +
    `sys_markers=${sysMarkers.length ? sysMarkers.map(([k, v]) => `${k}×${v}`).join(",") : "none"} | ` +
    `msg_markers=${msgMarkers.length ? msgMarkers.map(([k, v]) => `${k}×${v}`).join(",") : "none"}`
  );

  appendFileSync(LOG_FILE, JSON.stringify(log) + "\n");
}

export function getProxyLogs() {
  return allLogs.filter((l) => l.path.includes("/v1/messages"));
}
