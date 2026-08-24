import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrailDatabase } from "./database.js";
import { loadCorpus } from "./corpus.js";
import { ensureActivePolicy } from "./policy.js";
import { compileContext, recoverContext } from "./context.js";

describe("external human context compiler", () => {
  let directory: string;
  let db: TrailDatabase;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "trail-context-"));
    db = new TrailDatabase(join(directory, "context.db"));
    loadCorpus(db);
    ensureActivePolicy(db);
  });
  afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

  it("preserves literal current-request negatives and admits only the exact route", async () => {
    const task = "Fix the production route in the user-visible service checkout. Do not edit a copied checkout. Prove the browser-visible result before release.";
    const result = await compileContext(db, { task, environment: { client: "codex", workspace: "service-live" }, trigger: "start", evidenceState: {} });
    expect(result.bundle.status).toBe("ready");
    expect(result.bundle.environment.path).toBeTruthy();
    expect(result.bundle.environment.head).toMatch(/^[a-f0-9]{40}$/);
    expect(result.bundle.matchedTrails[0]?.id).toBe("trail-visible-checkout");
    expect(result.bundle.matchedTrails).toHaveLength(1);
    const negative = result.bundle.directives.find((item) => item.source.kind === "current_request" && item.type === "negative_constraint");
    expect(negative?.source.sourceQuote).toBe("Do not edit a copied checkout");
    expect(task).toContain(negative!.source.sourceQuote);
    expect(result.bundle.compiledPrompt).toContain("CURRENT USER REQUEST — HIGHEST PRIORITY");
    expect(result.bundle.compiledPrompt).toContain("LOCAL CONTRACT PRECEDENCE");
    expect(result.bundle.compiledPrompt).toContain("Never import those literals from historical context or guess a vendor-specific substitute.");
    expect(result.bundle.compiledPrompt).toContain("Do not guess first and inspect only after failure.");
    expect(result.bundle.compiledPrompt).toContain("ENVIRONMENT");
    expect(result.bundle.compiledPrompt).toContain("Do not edit a copied checkout");
  });

  it("keeps secondary routes on the primary exact identity surface", async () => {
    const task = "Repair the robot sensor configuration, prove the firmware still builds, and do not release until readings are observed from the attached device.";
    const result = await compileContext(db, { task, environment: { client: "serial-monitor", workspace: "firmware-device", authSurface: "none" }, trigger: "release", evidenceState: {} });
    expect(result.bundle.matchedTrails[0]?.id).toBe("trail-hardware-runtime-proof");
    expect(result.bundle.matchedTrails.map((trail) => trail.id)).not.toContain("trail-provider-completeness");
  });

  it("does not force a route when nothing applies", async () => {
    const result = await compileContext(db, { task: "Translate hello into French", environment: { client: "codex", workspace: "notes" }, trigger: "start", evidenceState: {} });
    expect(result.bundle.status).toBe("no_applicable_trail");
    expect(result.bundle.route).toEqual([]);
    expect(result.bundle.compiledPrompt).toContain("No applicable historical route");
  });

  it("surfaces missing environment and bounds recovery to one reroute", async () => {
    const first = await compileContext(db, { task: "Fix the blocked deployment authorization error", environment: { client: "codex" }, trigger: "failure", failure: "deployment blocked", evidenceState: {} });
    expect(first.bundle.status).toBe("needs_environment");
    expect(first.bundle.missingEnvironment).toContain("authSurface");
    const recovery = await recoverContext(db, first.bundle, "The visible checkout still did not change", {});
    expect(recovery.bundle.recoveryCount).toBe(1);
    const stopped = await recoverContext(db, recovery.bundle, "The second check failed", {});
    expect(stopped.bundle.status).toBe("blocked");
    expect(stopped.bundle.compiledPrompt).toContain("RECOVERY LIMIT REACHED");
  });

  it("stores immutable bundle versions", async () => {
    const first = await compileContext(db, { task: "Fix production deployment and prove the visible result", environment: { client: "codex" }, trigger: "start", evidenceState: {} });
    const recovery = await recoverContext(db, first.bundle, "HTTP verification failed", {});
    expect(recovery.bundle.id).not.toBe(first.bundle.id);
    expect(recovery.bundle.parentId).toBe(first.bundle.id);
    expect(db.getContextBundle(first.bundle.id)?.failure).toBeUndefined();
  });
});
