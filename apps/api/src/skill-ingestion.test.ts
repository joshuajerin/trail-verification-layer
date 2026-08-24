import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrailDatabase } from "./database.js";
import { parseSkillMetadata, SkillIngestionService } from "./skill-ingestion.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitForCompletion(service: SkillIngestionService, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = service.get(id);
    if (job?.status !== "scanning") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Ingestion did not complete in time.");
}

describe("live SKILL.md ingestion", () => {
  it("extracts explicit metadata and sensible folder fallbacks", () => {
    expect(parseSkillMetadata("---\nname: Browser Proof\nsubskill: Release\n---\n", "proof/browser/SKILL.md"))
      .toEqual({ skill: "Browser Proof", subskill: "Release" });
    expect(parseSkillMetadata("# Dependency Audit\n", "skills/dependency-audit/SKILL.md"))
      .toEqual({ skill: "Dependency Audit", subskill: "Core" });
  });

  it("recursively indexes metadata while keeping the public job snapshot bounded", async () => {
    const root = await mkdtemp(join(tmpdir(), "trail-skill-ingestion-"));
    temporaryPaths.push(root);
    await mkdir(join(root, "orient", "environment"), { recursive: true });
    await mkdir(join(root, "prove"), { recursive: true });
    await writeFile(join(root, "orient", "environment", "SKILL.md"), "---\nname: Resolve Workspace\nsubskill: Environment\n---\n# Resolve Workspace\n");
    await writeFile(join(root, "prove", "SKILL.md"), "# Browser Proof\n");
    await writeFile(join(root, "prove", "notes.md"), "not a skill");

    const database = new TrailDatabase(join(root, "trail.db"));
    try {
      const service = new SkillIngestionService(database);
      const started = await service.start(root, 138_000);
      const completed = await waitForCompletion(service, started.id);

      expect(completed).toMatchObject({ status: "completed", expectedTotal: 138_000, discovered: 2, indexed: 2, errors: 0, skillCount: 2, subskillCount: 2 });
      expect(completed?.recent).toHaveLength(2);
      expect(completed).not.toHaveProperty("skills");
      expect(database.sourceSummary().providers).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "skill-md", count: 2 })]));
      expect(database.sourceCandidates()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
