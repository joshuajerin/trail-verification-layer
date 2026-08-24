#!/usr/bin/env node
import { createInterface } from "node:readline";

const apiBase = process.env.TRAIL_API_BASE ?? "http://127.0.0.1:4317";

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const tools = [
  {
    name: "trail_build_context",
    description: "Build a source-backed execution brief from the current request and approved human context.",
    annotations: { readOnlyHint: true, idempotentHint: false },
    execution: { taskSupport: "forbidden" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: { type: "string", minLength: 3 },
        workspace: { type: "string" },
        environment: { type: "object", additionalProperties: { type: "string" } },
        trigger: { type: "string", enum: ["start", "failure", "release"] },
        failure: { type: "string" },
        evidenceState: { type: "object", additionalProperties: { type: "boolean" } },
      },
    },
  },
  {
    name: "trail_recover",
    description: "Request the single bounded recovery route after an observed failure.",
    annotations: { readOnlyHint: false, idempotentHint: false },
    execution: { taskSupport: "forbidden" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["bundleId", "failure"],
      properties: {
        bundleId: { type: "string" },
        failure: { type: "string" },
        evidenceState: { type: "object", additionalProperties: { type: "boolean" } },
      },
    },
  },
  {
    name: "trail_verify",
    description: "Run human-approved evidence adapters. Agent prose cannot satisfy this release gate.",
    annotations: { readOnlyHint: false, idempotentHint: false },
    execution: { taskSupport: "forbidden" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["bundleId", "workspace"],
      properties: {
        bundleId: { type: "string" },
        workspace: { type: "string" },
        adapters: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "trail_run_domain_evals",
    description: "Run real paired TRAIL evaluations for robotics, SaaS, and AI/ML through the configured live provider. Results are based on independent evidence gates, never agent prose.",
    annotations: { readOnlyHint: false, idempotentHint: false },
    execution: { taskSupport: "forbidden" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repetitions: { type: "integer", minimum: 1, maximum: 10, description: "Paired runs per domain. Default: 3." },
      },
    },
  },
];

async function request(path: string, body: unknown) {
  const response = await fetch(`${apiBase}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error ?? `TRAIL API returned ${response.status}`));
  return payload;
}

async function callTool(name: string, args: Record<string, unknown>) {
  if (name === "trail_build_context") {
    const response = await request("/api/context/compile", args);
    return { bundle: response.bundle, provider: response.provider };
  }
  if (name === "trail_recover") {
    const { bundleId, ...body } = args;
    return request(`/api/context/${String(bundleId)}/recover`, body);
  }
  if (name === "trail_verify") {
    const { bundleId, ...body } = args;
    return request(`/api/context/${String(bundleId)}/verify`, body);
  }
  if (name === "trail_run_domain_evals") return request("/api/evals/domains/run", args);
  throw new Error(`Unknown tool: ${name}`);
}

function send(message: unknown) { process.stdout.write(`${JSON.stringify(message)}\n`); }

async function handle(message: RpcRequest) {
  if (message.method === "notifications/initialized") return;
  const id = message.id ?? null;
  try {
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "trail", version: "0.1.0" }, instructions: "Use trail_build_context at task start. Current user instructions always outrank retrieved trails." } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools } });
    } else if (message.method === "tools/call") {
      const params = message.params ?? {};
      const result = await callTool(String(params.name ?? ""), (params.arguments ?? {}) as Record<string, unknown>);
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    }
  } catch (error) {
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : "TRAIL tool failed" }], isError: true } });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  try { void handle(JSON.parse(line) as RpcRequest); }
  catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
});
