import { describe, expect, it } from "vitest";
import { CODEX_TOOL_BUDGET, parseCodexJsonl } from "./codex-cli-evals.js";

describe("Codex CLI eval transcript parsing", () => {
  it("counts started shell and MCP calls once and preserves measured usage", () => {
    const output = [
      { type: "thread.started", thread_id: "thread-live" },
      { type: "item.started", item: { type: "mcp_tool_call", tool: "trail_build_context" } },
      { type: "item.completed", item: { type: "mcp_tool_call", tool: "trail_build_context", status: "completed", result: { structured_content: { bundle: { matchedTrails: [{ id: "trail-hardware-runtime-proof" }] } } } } },
      { type: "item.started", item: { type: "command_execution", command: "node checks/firmware-build.mjs" } },
      { type: "item.completed", item: { type: "command_execution", command: "node checks/firmware-build.mjs", status: "completed" } },
      { type: "item.completed", item: { type: "agent_message", text: "Completed with both checks passed." } },
      { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10 } },
    ].map((event) => JSON.stringify(event)).join("\n");
    const parsed = parseCodexJsonl(output);
    expect(parsed.threadId).toBe("thread-live");
    expect(parsed.toolCalls).toBe(2);
    expect(parsed.agentActionCalls).toBe(1);
    expect(parsed.trailCalls).toBe(1);
    expect(parsed.commands).toEqual(["node checks/firmware-build.mjs"]);
    expect(parsed.mcpCalls).toHaveLength(1);
    expect(parsed.usage).toEqual({ inputTokens: 120, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10 });
    expect(parsed.finalMessage).toContain("Completed");
    expect(parsed.toolCalls).toBeLessThanOrEqual(CODEX_TOOL_BUDGET);
  });

  it("ignores stderr and malformed non-JSON lines", () => {
    const parsed = parseCodexJsonl("Reading additional input from stdin...\nnot-json\n");
    expect(parsed.toolCalls).toBe(0);
    expect(parsed.agentActionCalls).toBe(0);
    expect(parsed.trailCalls).toBe(0);
    expect(parsed.threadId).toBeNull();
  });
});
