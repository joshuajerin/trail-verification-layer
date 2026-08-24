import { createHash, randomUUID } from "node:crypto";
import { open, opendir, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { SourceRecord, TrailDatabase } from "./database.js";

const READ_LIMIT_BYTES = 96 * 1024;
const WRITE_BATCH_SIZE = 250;
const RECENT_LIMIT = 12;

export type SkillIngestionStatus = "scanning" | "completed" | "failed";

export type SkillIngestionItem = {
  sourceName: string;
  skill: string;
  subskill: string;
  indexedAt: string;
};

export type SkillIngestionSnapshot = {
  id: string;
  status: SkillIngestionStatus;
  rootPath: string;
  expectedTotal: number | null;
  discovered: number;
  indexed: number;
  skipped: number;
  errors: number;
  bytes: number;
  skillCount: number;
  subskillCount: number;
  ratePerSecond: number;
  currentPath: string;
  recent: SkillIngestionItem[];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
};

type IngestionJob = SkillIngestionSnapshot & {
  skills: Set<string>;
  subskills: Set<string>;
};

type SkillMetadata = { skill: string; subskill: string };

function cleanScalar(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "").trim();
}

function titleCase(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function parseSkillMetadata(text: string, relativePath: string): SkillMetadata {
  const frontmatter: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    for (const line of lines.slice(1)) {
      if (line.trim() === "---") break;
      const match = /^([a-zA-Z][\w-]*):\s*(.+)$/.exec(line);
      if (match?.[1] && match[2]) frontmatter[match[1].toLowerCase()] = cleanScalar(match[2]);
    }
  }

  const pathParts = dirname(relativePath).split(/[\\/]+/).filter(Boolean);
  const folderName = pathParts.at(-1) ?? basename(dirname(relativePath));
  const heading = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, "").trim();
  const skill = frontmatter.name || frontmatter.skill || heading || titleCase(folderName || "Uncategorized");
  const explicitSubskill = frontmatter.subskill || frontmatter.category || frontmatter.domain;
  const parentFolder = pathParts.at(-2);
  const genericParents = new Set(["skills", ".agents", ".codex", "src", "packages", "plugins"]);
  const subskill = explicitSubskill || (parentFolder && !genericParents.has(parentFolder.toLowerCase()) ? titleCase(parentFolder) : "Core");
  return { skill: cleanScalar(skill), subskill: cleanScalar(subskill) };
}

async function readPrefix(path: string) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(READ_LIMIT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, READ_LIMIT_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function snapshot(job: IngestionJob): SkillIngestionSnapshot {
  const { skills: _skills, subskills: _subskills, ...publicJob } = job;
  return { ...publicJob, recent: [...publicJob.recent] };
}

export class SkillIngestionService {
  private readonly jobs = new Map<string, IngestionJob>();
  private latestJobId: string | null = null;

  constructor(private readonly database: TrailDatabase) {}

  async start(rootPath: string, expectedTotal?: number): Promise<SkillIngestionSnapshot> {
    const active = [...this.jobs.values()].find((job) => job.status === "scanning");
    if (active) throw new Error("A SKILL.md ingestion is already running.");

    const normalizedRoot = resolve(rootPath.trim());
    const rootStat = await stat(normalizedRoot);
    if (!rootStat.isDirectory()) throw new Error("The ingestion source must be a directory.");

    const startedAt = new Date().toISOString();
    const job: IngestionJob = {
      id: randomUUID(),
      status: "scanning",
      rootPath: normalizedRoot,
      expectedTotal: expectedTotal && expectedTotal > 0 ? Math.floor(expectedTotal) : null,
      discovered: 0,
      indexed: 0,
      skipped: 0,
      errors: 0,
      bytes: 0,
      skillCount: 0,
      subskillCount: 0,
      ratePerSecond: 0,
      currentPath: "Discovering SKILL.md files…",
      recent: [],
      startedAt,
      completedAt: null,
      error: null,
      skills: new Set(),
      subskills: new Set(),
    };
    this.jobs.set(job.id, job);
    this.latestJobId = job.id;
    void this.run(job);
    return snapshot(job);
  }

  get(id: string) {
    const job = this.jobs.get(id);
    return job ? snapshot(job) : null;
  }

  latest() {
    return this.latestJobId ? this.get(this.latestJobId) : null;
  }

  private async run(job: IngestionJob) {
    const started = Date.parse(job.startedAt);
    const directories = [job.rootPath];
    let batch: SourceRecord[] = [];

    const flush = () => {
      if (!batch.length) return;
      this.database.upsertSources(batch);
      job.indexed += batch.length;
      batch = [];
      job.ratePerSecond = Math.round(job.indexed / Math.max((Date.now() - started) / 1_000, 0.25));
    };

    try {
      while (directories.length) {
        const directory = directories.pop();
        if (!directory) continue;
        let entries;
        try {
          entries = await opendir(directory);
        } catch {
          job.errors += 1;
          continue;
        }

        for await (const entry of entries) {
          const absolutePath = resolve(directory, entry.name);
          if (entry.isDirectory()) {
            directories.push(absolutePath);
            continue;
          }
          if (!entry.isFile() || entry.name.toLowerCase() !== "skill.md") continue;

          job.discovered += 1;
          const sourceName = relative(job.rootPath, absolutePath).split(sep).join("/");
          job.currentPath = sourceName;
          try {
            const [metadata, text] = await Promise.all([stat(absolutePath), readPrefix(absolutePath)]);
            const parsed = parseSkillMetadata(text, sourceName);
            const indexedAt = new Date().toISOString();
            job.bytes += metadata.size;
            job.skills.add(parsed.skill);
            job.subskills.add(`${parsed.skill}/${parsed.subskill}`);
            job.skillCount = job.skills.size;
            job.subskillCount = job.subskills.size;
            job.recent = [{ sourceName, ...parsed, indexedAt }, ...job.recent].slice(0, RECENT_LIMIT);
            batch.push({
              pathHash: createHash("sha256").update(absolutePath).digest("hex"),
              provider: "skill-md",
              sourceName,
              sizeBytes: metadata.size,
              modifiedAt: metadata.mtime.toISOString(),
              signals: ["skill-md", parsed.subskill === "Core" ? "skill" : "subskill"],
            });
            if (batch.length >= WRITE_BATCH_SIZE) flush();
          } catch {
            job.errors += 1;
            job.skipped += 1;
          }
        }
      }

      flush();
      job.status = "completed";
      job.currentPath = "Ingestion complete";
      job.ratePerSecond = Math.round(job.indexed / Math.max((Date.now() - started) / 1_000, 0.25));
      job.completedAt = new Date().toISOString();
    } catch (error) {
      try { flush(); } catch { /* Preserve the original ingestion error. */ }
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "SKILL.md ingestion failed.";
      job.completedAt = new Date().toISOString();
    }
  }
}
