import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCorpus } from "./corpus.js";
import { TrailDatabase } from "./database.js";
import { createTrailMcpServer } from "./mcp-server.js";
import { ensureActivePolicy } from "./policy.js";

function toolOutput(result: unknown) {
  const content = typeof result === "object" && result !== null && "content" in result
    ? (result as { content: unknown }).content
    : undefined;
  if (!Array.isArray(content) || content[0]?.type !== "text" || typeof content[0].text !== "string") return {};
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("TRAIL MCP router", () => {
  let directory: string;
  let db: TrailDatabase;
  let client: Client;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "trail-mcp-"));
    db = new TrailDatabase(join(directory, "router.db"));
    loadCorpus(db);
    ensureActivePolicy(db);
    const server = createTrailMcpServer(db);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as never);
    client = new Client({ name: "trail-test-client", version: "1.0.0" });
    await client.connect(clientTransport as never);
  });

  afterEach(async () => {
    await client.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("publishes exactly the router, recovery, and verification tools", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(["trail_recover", "trail_route", "trail_verify"]);
  });

  it("returns source-backed Do, Do Not, route, and proof for a matching task", async () => {
    const result = await client.callTool({
      name: "trail_route",
      arguments: {
        task: "Fix the production route in the user-visible service checkout. Do not edit a copied checkout.",
        phase: "start",
        context: { client: "codex", workspace: "service-live" },
      },
    });
    const output = toolOutput(result);
    expect(output.decision).toBe("route");
    expect(output.route_id).toEqual(expect.any(String));
    expect(output.must_not_do).toContain("Do not edit a copied checkout");
    expect(output.workflow).toEqual(expect.any(Array));
    expect(output.proof_required).toEqual(expect.any(Array));
  });

  it("blocks agent-reported evidence from becoming release eligible", async () => {
    const routed = await client.callTool({
      name: "trail_route",
      arguments: { task: "Fix the production route in the user-visible service checkout", context: { client: "codex", workspace: "service-live" } },
    });
    const route = toolOutput(routed) as { route_id: string; proof_required: Array<{ id: string }> };
    const verified = await client.callTool({
      name: "trail_verify",
      arguments: {
        route_id: route.route_id,
        evidence: route.proof_required.map((item) => ({ evidence_id: item.id, verifier: "agent-claim", observed: "looks good", passed: true })),
      },
    });
    const output = toolOutput(verified);
    expect(output.decision).toBe("blocked");
    expect(output.release_eligible).toBe(false);
  });

  it("returns no_match instead of forcing unrelated context", async () => {
    const result = await client.callTool({
      name: "trail_route",
      arguments: { task: "Translate hello into French", context: { client: "codex", workspace: "notes" } },
    });
    expect(toolOutput(result).decision).toBe("no_match");
  });

  it("permits only one recovery", async () => {
    const routed = toolOutput(await client.callTool({
      name: "trail_route",
      arguments: { task: "Fix the production route in the user-visible service checkout", context: { client: "codex", workspace: "service-live" } },
    })) as { route_id: string };
    const recovered = toolOutput(await client.callTool({
      name: "trail_recover",
      arguments: { route_id: routed.route_id, failure: "The named check failed", context: { client: "codex", workspace: "service-live" } },
    })) as { route_id: string; decision: string };
    expect(recovered.decision).toBe("route");
    const stopped = toolOutput(await client.callTool({
      name: "trail_recover",
      arguments: { route_id: recovered.route_id, failure: "The recovery check failed", context: { client: "codex", workspace: "service-live" } },
    }));
    expect(stopped.decision).toBe("blocked");
  });
});
