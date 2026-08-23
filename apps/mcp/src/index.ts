#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const routerUrl = process.env.TRAIL_ROUTER_URL ?? "http://127.0.0.1:4317/mcp";
const apiKey = process.env.TRAIL_API_KEY ?? "";

const contextSchema = {
  client: z.string().min(1).optional(), repository: z.string().min(1).optional(), branch: z.string().min(1).optional(),
  revision: z.string().regex(/^[a-f0-9]{7,40}$/i).optional(), platform: z.string().min(1).optional(), runtime: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(), deployment: z.string().min(1).optional(),
};

const client = new Client({ name: "trail-stdio-bridge", version: "1.0.0" });
const transportOptions = apiKey ? { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } } : {};
const transport = new StreamableHTTPClientTransport(new URL(routerUrl), transportOptions);
// The SDK's transport declaration is compiled without exactOptionalPropertyTypes,
// while this workspace enables it. Runtime transport compatibility is standard MCP.
await client.connect(transport as never);

async function forward(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  if ("content" in result) return result;
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: true };
}

const server = new McpServer(
  { name: "trail-stdio-bridge", version: "1.0.0" },
  { instructions: "This is a thin bridge to the hosted TRAIL router. Use trail_route at task start, trail_recover after failures, and trail_verify before completion." },
);

server.registerTool("trail_route", {
  description: "Forward a task and safe working context to the hosted TRAIL router.",
  inputSchema: {
    task: z.string().min(3), phase: z.enum(["start", "failure", "release"]).default("start"), context: z.object(contextSchema).default({}),
    failure: z.string().min(1).optional(), completed_checkpoints: z.array(z.string().min(1)).default([]),
  },
  annotations: { readOnlyHint: true, idempotentHint: false },
}, async (args) => (await forward("trail_route", args)) as never);

server.registerTool("trail_recover", {
  description: "Forward one observed failure to the hosted TRAIL router for bounded recovery.",
  inputSchema: {
    route_id: z.string().uuid(), failure: z.string().min(1), context: z.object(contextSchema).default({}),
    completed_checkpoints: z.array(z.string().min(1)).default([]),
  },
  annotations: { readOnlyHint: true, idempotentHint: false },
}, async (args) => (await forward("trail_recover", args)) as never);

server.registerTool("trail_verify", {
  description: "Forward structured evidence to the hosted TRAIL router. Agent evidence is advisory until trusted CI attests it.",
  inputSchema: {
    route_id: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{7,40}$/i).optional(),
    evidence: z.array(z.object({ evidence_id: z.string().min(1), verifier: z.string().min(1), observed: z.string(), passed: z.boolean() })).default([]),
  },
  annotations: { readOnlyHint: true, idempotentHint: false },
}, async (args) => (await forward("trail_verify", args)) as never);

await server.connect(new StdioServerTransport());
