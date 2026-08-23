import { describe, expect, it } from "vitest";
import { ingestClaudeMemContext } from "./claude-mem.js";

describe("Claude Mem local ingestion", () => {
  it("redacts a local context snapshot and keeps it review-only", async () => {
    const requests: string[] = [];
    const result = await ingestClaudeMemContext("trail-verification-layer", {
      baseUrl: "http://127.0.0.1:37701",
      fetcher: async (input) => {
        requests.push(String(input));
        if (String(input).includes("/health")) return new Response('{"status":"ok"}');
        return new Response("The deploy is wrong. Email me at private@example.com and verify the remote branch.");
      },
    });
    expect(requests).toHaveLength(2);
    expect(result.status).toBe("available");
    expect(result.preview?.sourceName).toBe("claude-mem:trail-verification-layer");
    expect(result.preview?.requiresReview).toBe(true);
    expect(result.preview?.redactedText).not.toContain("private@example.com");
  });

  it("does not create an ingestion when Claude Mem has no project history", async () => {
    const result = await ingestClaudeMemContext("trail-verification-layer", {
      fetcher: async (input) => String(input).includes("/health")
        ? new Response('{"status":"ok"}')
        : new Response("# Recent context\n\nNo previous sessions found."),
    });
    expect(result).toMatchObject({ status: "empty", project: "trail-verification-layer" });
    expect(result.preview).toBeUndefined();
  });

  it("refuses a non-local Claude Mem endpoint", async () => {
    const result = await ingestClaudeMemContext("trail-verification-layer", { baseUrl: "https://example.com" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("loopback");
  });
});
