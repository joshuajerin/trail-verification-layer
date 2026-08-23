import type { Trail } from "@trail/contracts";
import { describe, expect, it } from "vitest";
import { TrailRetrievalInputError, retrieveTrailsDeterministically } from "./engine.js";
import {
  AUTHENTICATION_PROVIDER_STATE_TRAIL,
  BUILD_VERSUS_DEPLOYMENT_TRAIL,
  TRAIL_RETRIEVAL_FIXTURES,
  WRONG_CHECKOUT_TRAIL,
} from "./fixtures.js";

const productionTask = "Update the production route, prove it works, and prepare the PR.";
const productionEnvironment = { client: "codex", workspace: "service-live", runtime: "node" };

function retrieve(overrides: Partial<Parameters<typeof retrieveTrailsDeterministically>[0]> = {}) {
  return retrieveTrailsDeterministically({
    task: productionTask,
    trigger: "start",
    environment: productionEnvironment,
    candidates: TRAIL_RETRIEVAL_FIXTURES,
    ...overrides,
  });
}

describe("deterministic TRAIL retrieval", () => {
  it("returns the correct top result for the task-start environment", () => {
    const result = retrieve();

    expect(result.selectedTrail?.trail.id).toBe(WRONG_CHECKOUT_TRAIL.id);
    expect(result.applicableTrails.map((match) => match.trail.id)).toEqual([
      WRONG_CHECKOUT_TRAIL.id,
      BUILD_VERSUS_DEPLOYMENT_TRAIL.id,
    ]);
    expect(result.noMatch).toEqual({ isNoMatch: false, reason: null });
  });

  it("hard-rejects an environment mismatch and never scores it", () => {
    const result = retrieve({ environment: { ...productionEnvironment, workspace: "service-copy" } });
    const rejected = result.rejectedNearMatches.find((match) => match.trail.id === WRONG_CHECKOUT_TRAIL.id);

    expect(rejected?.score).toBeNull();
    expect(rejected?.signals).toBeNull();
    expect(rejected?.rejectionReasons).toContain(
      'environment mismatch for workspace: expected "service-live", received "service-copy"',
    );
    expect(result.applicableTrails.some((match) => match.trail.id === WRONG_CHECKOUT_TRAIL.id)).toBe(false);
  });

  it("hard-filters path and HEAD constraints introduced by the shared environment contract", () => {
    const scopedTrail = {
      ...WRONG_CHECKOUT_TRAIL,
      id: "trail-path-and-head",
      environment: {
        ...WRONG_CHECKOUT_TRAIL.environment,
        path: "C:/work/service-live",
        head: "abc1234",
      },
    } satisfies Trail;
    const matching = retrieve({
      environment: {
        ...productionEnvironment,
        path: "C:\\work\\service-live",
        head: "ABC1234",
      },
      candidates: [scopedTrail],
    });
    const mismatching = retrieve({
      environment: {
        ...productionEnvironment,
        path: "C:/work/service-copy",
        head: "def5678",
      },
      candidates: [scopedTrail],
    });

    expect(matching.selectedTrail?.trail.id).toBe(scopedTrail.id);
    expect(matching.selectedTrail?.matchReasons).toContain(
      'environment path matched required value "C:/work/service-live"',
    );
    expect(matching.selectedTrail?.matchReasons).toContain('environment head matched required value "abc1234"');
    expect(mismatching.rejectedNearMatches[0]?.rejectionReasons).toEqual([
      'environment mismatch for path: expected "C:/work/service-live", received "C:/work/service-copy"',
      'environment mismatch for head: expected "abc1234", received "def5678"',
    ]);
  });

  it("hard-rejects a trail when an invalidator is active", () => {
    const invalidated = {
      ...WRONG_CHECKOUT_TRAIL,
      invalidators: ["task:any(skip|bypass)"],
    } satisfies Trail;
    const result = retrieve({
      task: `${productionTask} Bypass the checkout verification.`,
      candidates: [invalidated, BUILD_VERSUS_DEPLOYMENT_TRAIL],
    });
    const rejected = result.rejectedNearMatches.find((match) => match.trail.id === invalidated.id);

    expect(rejected?.score).toBeNull();
    expect(rejected?.rejectionReasons).toContain("active invalidator: task:any(skip|bypass)");
    expect(result.applicableTrails.some((match) => match.trail.id === invalidated.id)).toBe(false);
  });

  it("uses trigger differences deterministically without treating them as hard filters", () => {
    const atStart = retrieve({ trigger: "start" });
    const beforeRelease = retrieve({ trigger: "release" });

    expect(atStart.selectedTrail?.trail.id).toBe(WRONG_CHECKOUT_TRAIL.id);
    expect(beforeRelease.selectedTrail?.trail.id).toBe(BUILD_VERSUS_DEPLOYMENT_TRAIL.id);
    expect(beforeRelease.applicableTrails.map((match) => match.trail.id)).toContain(WRONG_CHECKOUT_TRAIL.id);
    expect(beforeRelease.applicableTrails.find((match) => match.trail.id === WRONG_CHECKOUT_TRAIL.id)?.matchReasons)
      .toContain('trigger "release" is not listed; no trigger points awarded');
  });

  it("returns a truthful no-match result instead of forcing a weak trail", () => {
    const result = retrieve({
      task: "Tune an underwater telescope on an unknown mainframe.",
      trigger: "start",
      environment: { os: "plan9" },
    });

    expect(result.applicableTrails).toEqual([]);
    expect(result.selectedTrail).toBeNull();
    expect(result.noMatch).toEqual({
      isNoMatch: true,
      reason: "No approved trail passed mandatory filters, invalidators, and the minimum relevance threshold.",
    });
    expect(result.rejectedNearMatches).toHaveLength(3);
  });

  it("does not match short applicability terms inside unrelated words", () => {
    const result = retrieve({
      task: "Prepare a release summary.",
      candidates: [WRONG_CHECKOUT_TRAIL],
    });

    expect(result.selectedTrail).toBeNull();
    expect(result.applicableTrails).toEqual([]);
    expect(result.rejectedNearMatches[0]?.rejectionReasons).toContain(
      "applicability condition not met: task:any(route|checkout|worktree|branch|pull request|pr)",
    );
  });

  it("orders equal candidates by stable trail id regardless of input order", () => {
    const alpha = { ...WRONG_CHECKOUT_TRAIL, id: "trail-alpha", confidence: 0.9 } satisfies Trail;
    const zulu = { ...WRONG_CHECKOUT_TRAIL, id: "trail-zulu", confidence: 0.9 } satisfies Trail;
    const first = retrieve({ candidates: [zulu, alpha] });
    const second = retrieve({ candidates: [alpha, zulu] });

    expect(first.applicableTrails.map((match) => match.trail.id)).toEqual(["trail-alpha", "trail-zulu"]);
    expect(second.applicableTrails.map((match) => match.trail.id)).toEqual(["trail-alpha", "trail-zulu"]);
  });

  it("provides human-readable signal and filter explanations", () => {
    const selected = retrieve().selectedTrail;

    expect(selected?.matchReasons).toContain('environment workspace matched required value "service-live"');
    expect(selected?.matchReasons).toContain('applicability condition matched: task:any(route|checkout|worktree|branch|pull request|pr)');
    expect(selected?.matchReasons.some((reason) => reason.startsWith("task-family signal matched"))).toBe(true);
    expect(selected?.matchReasons.some((reason) => reason.startsWith("intent signal matched"))).toBe(true);
    expect(selected?.matchReasons).toContain('trigger "start" is supported');
  });

  it("explains why rejected near matches failed mandatory applicability", () => {
    const rejected = retrieve().rejectedNearMatches.find(
      (match) => match.trail.id === AUTHENTICATION_PROVIDER_STATE_TRAIL.id,
    );

    expect(rejected?.rejectionReasons).toEqual([
      'missing required environment field "authSurface" (expected "github")',
      "applicability condition not met: task:any(authentication|auth|login|provider|credential|token)",
    ]);
  });

  it("rejects malformed requests with actionable paths", () => {
    expect(() => retrieveTrailsDeterministically({
      task: " ",
      trigger: "pre-release",
      environment: {},
      candidates: [],
    } as never)).toThrow(TrailRetrievalInputError);
    expect(() => retrieveTrailsDeterministically({
      task: productionTask,
      trigger: "start",
      environment: productionEnvironment,
      candidates: [WRONG_CHECKOUT_TRAIL, WRONG_CHECKOUT_TRAIL],
    })).toThrow("duplicate candidate trail id: trail-wrong-checkout");
  });
});
