import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ContextBundle, EvidenceObservation, IngestionPreview, RetrievalPolicy, RunEvent, RunMetrics, Trail } from "@trail/contracts";

type RunRecord = {
  id: string;
  mode: "baseline" | "guided" | "paired";
  executor: "deterministic-fixture" | "openai-responses";
  status: "running" | "completed" | "failed";
  task: Record<string, unknown>;
  metrics: Record<string, RunMetrics>;
  createdAt: string;
};

export type SourceRecord = {
  pathHash: string;
  provider: string;
  sourceName: string;
  sizeBytes: number;
  modifiedAt: string;
  signals: string[];
};

export class TrailDatabase {
  readonly db: DatabaseSync;
  private ftsAvailable = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trails (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        task_family TEXT NOT NULL,
        body_json TEXT NOT NULL,
        approved_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS trails_search (
        trail_id TEXT PRIMARY KEY,
        content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ingestions (
        id TEXT PRIMARY KEY,
        format TEXT NOT NULL,
        source_name TEXT NOT NULL,
        body_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'previewed',
        trail_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sources (
        path_hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        source_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        signal_json TEXT NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS sources_provider_modified_idx ON sources(provider, modified_at DESC);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        executor TEXT NOT NULL,
        status TEXT NOT NULL,
        task_json TEXT NOT NULL,
        metrics_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS context_bundles (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        status TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence_observations (
        id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (bundle_id) REFERENCES context_bundles(id) ON DELETE CASCADE
      );
    `);
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS trails_fts USING fts5(
        trail_id UNINDEXED,
        content
      );`);
      this.ftsAvailable = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("no such module: fts5")) throw error;
    }
    const ingestionColumns = new Set(
      (this.db.prepare("PRAGMA table_info(ingestions)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!ingestionColumns.has("status")) this.db.exec("ALTER TABLE ingestions ADD COLUMN status TEXT NOT NULL DEFAULT 'previewed'");
    if (!ingestionColumns.has("trail_id")) this.db.exec("ALTER TABLE ingestions ADD COLUMN trail_id TEXT");
  }

  close() {
    this.db.close();
  }

  upsertTrail(trail: Trail) {
    const approvedAt = trail.reviewedAt ?? null;
    this.db
      .prepare(`INSERT INTO trails (id, status, task_family, body_json, approved_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, task_family=excluded.task_family,
        body_json=excluded.body_json, approved_at=excluded.approved_at`)
      .run(trail.id, trail.reviewStatus, trail.taskFamily, JSON.stringify(trail), approvedAt);
    const searchText = [
      trail.title,
      trail.summary,
      trail.intent,
      trail.taskFamily,
      ...trail.failureSignatures,
      ...trail.applicability,
      ...trail.tags,
    ].join(" ");
    this.db.prepare(`INSERT INTO trails_search (trail_id, content) VALUES (?, ?)
      ON CONFLICT(trail_id) DO UPDATE SET content=excluded.content`).run(trail.id, searchText);
    if (this.ftsAvailable) {
      this.db.prepare("DELETE FROM trails_fts WHERE trail_id = ?").run(trail.id);
      this.db.prepare("INSERT INTO trails_fts (trail_id, content) VALUES (?, ?)").run(trail.id, searchText);
    }
  }

  getTrails(status = "approved"): Trail[] {
    const rows = this.db.prepare("SELECT body_json FROM trails WHERE status = ? ORDER BY approved_at DESC, id").all(status) as Array<{ body_json: string }>;
    return rows.map((row) => JSON.parse(row.body_json) as Trail);
  }

  getTrail(id: string): Trail | null {
    const row = this.db.prepare("SELECT body_json FROM trails WHERE id = ?").get(id) as { body_json: string } | undefined;
    return row ? (JSON.parse(row.body_json) as Trail) : null;
  }

  searchTrailIds(query: string, limit = 20): Array<{ id: string; rank: number }> {
    const tokens = query.toLowerCase().match(/[a-z0-9_\-]{3,}/g)?.slice(0, 18) ?? [];
    if (tokens.length === 0) return [];
    if (!this.ftsAvailable) {
      const unique = [...new Set(tokens)];
      const rows = this.db.prepare("SELECT trail_id, content FROM trails_search").all() as Array<{ trail_id: string; content: string }>;
      return rows
        .map((row) => {
          const content = row.content.toLowerCase();
          const matches = unique.reduce((sum, token) => sum + (content.includes(token) ? 1 : 0), 0);
          return { id: row.trail_id, rank: matches ? -matches / unique.length : 0 };
        })
        .filter((row) => row.rank < 0)
        .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
        .slice(0, limit);
    }
    const ftsQuery = [...new Set(tokens)].map((token) => `"${token.replaceAll('"', '')}"`).join(" OR ");
    const rows = this.db
      .prepare("SELECT trail_id, bm25(trails_fts) AS rank FROM trails_fts WHERE trails_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(ftsQuery, limit) as Array<{ trail_id: string; rank: number }>;
    return rows.map((row) => ({ id: row.trail_id, rank: row.rank }));
  }

  saveIngestion(preview: IngestionPreview) {
    this.db
      .prepare("INSERT OR REPLACE INTO ingestions (id, format, source_name, body_json, status, trail_id) VALUES (?, ?, ?, ?, 'previewed', NULL)")
      .run(preview.id, preview.format, preview.sourceName, JSON.stringify(preview));
  }

  getIngestion(id: string): IngestionPreview | null {
    const row = this.db.prepare("SELECT body_json FROM ingestions WHERE id = ?").get(id) as { body_json: string } | undefined;
    return row ? (JSON.parse(row.body_json) as IngestionPreview) : null;
  }

  saveContextBundle(bundle: ContextBundle) {
    this.db.prepare("INSERT INTO context_bundles (id, parent_id, status, body_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(bundle.id, bundle.parentId, bundle.status, JSON.stringify(bundle), bundle.createdAt);
  }

  getContextBundle(id: string): ContextBundle | null {
    const row = this.db.prepare("SELECT body_json FROM context_bundles WHERE id = ?").get(id) as { body_json: string } | undefined;
    return row ? JSON.parse(row.body_json) as ContextBundle : null;
  }

  saveEvidenceObservation(observation: EvidenceObservation) {
    this.db.prepare("INSERT INTO evidence_observations (id, bundle_id, evidence_id, body_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(observation.id, observation.bundleId, observation.evidenceId, JSON.stringify(observation), observation.timestamp);
  }

  getEvidenceObservations(bundleId: string): EvidenceObservation[] {
    const rows = this.db.prepare("SELECT body_json FROM evidence_observations WHERE bundle_id = ? ORDER BY created_at, id").all(bundleId) as Array<{ body_json: string }>;
    return rows.map((row) => JSON.parse(row.body_json) as EvidenceObservation);
  }

  listIngestions(limit = 30) {
    const rows = this.db.prepare(`SELECT id, format, source_name, body_json, status, trail_id, created_at
      FROM ingestions ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit) as Array<{
        id: string;
        format: IngestionPreview["format"];
        source_name: string;
        body_json: string;
        status: "previewed" | "drafted" | "approved";
        trail_id: string | null;
        created_at: string;
      }>;
    return rows.map((row) => {
      const preview = JSON.parse(row.body_json) as IngestionPreview;
      return {
        id: row.id,
        format: row.format,
        sourceName: row.source_name,
        status: row.status,
        trailId: row.trail_id,
        redactionCount: preview.redactionCount,
        candidateSignals: preview.candidateSignals,
        requiresReview: preview.requiresReview,
        createdAt: row.created_at,
      };
    });
  }

  markIngestionDrafted(id: string, trailId: string) {
    this.db.prepare("UPDATE ingestions SET status = 'drafted', trail_id = ? WHERE id = ?").run(trailId, id);
  }

  markIngestionApproved(trailId: string) {
    this.db.prepare("UPDATE ingestions SET status = 'approved' WHERE trail_id = ?").run(trailId);
  }

  upsertSource(record: SourceRecord) {
    this.upsertSources([record]);
  }

  upsertSources(records: SourceRecord[]) {
    if (!records.length) return;
    const statement = this.db.prepare(`INSERT INTO sources (path_hash, provider, source_name, size_bytes, modified_at, signal_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path_hash) DO UPDATE SET provider=excluded.provider, source_name=excluded.source_name,
      size_bytes=excluded.size_bytes, modified_at=excluded.modified_at, signal_json=excluded.signal_json`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        statement.run(record.pathHash, record.provider, record.sourceName, record.sizeBytes, record.modifiedAt, JSON.stringify(record.signals));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  sourceSummary() {
    const rows = this.db.prepare("SELECT provider, COUNT(*) AS count, SUM(size_bytes) AS bytes FROM sources GROUP BY provider").all() as Array<{ provider: string; count: number; bytes: number }>;
    const signalRows = this.db.prepare(`SELECT json_each.value AS signal, COUNT(*) AS count
      FROM sources, json_each(sources.signal_json)
      GROUP BY json_each.value`).all() as Array<{ signal: string; count: number }>;
    const signals = Object.fromEntries(signalRows.map((row) => [row.signal, Number(row.count)]));
    return { providers: rows, total: rows.reduce((sum, row) => sum + Number(row.count), 0), signals };
  }

  sourceCandidates(limit = 50) {
    const rows = this.db.prepare("SELECT path_hash, provider, source_name, size_bytes, modified_at, signal_json FROM sources WHERE provider IN ('codex', 'claude')").all() as Array<{
      path_hash: string; provider: string; source_name: string; size_bytes: number; modified_at: string; signal_json: string;
    }>;
    return rows
      .map((row) => {
        const signals = JSON.parse(row.signal_json) as string[];
        const score = signals.reduce((total, signal) => total + ({ "user-correction": 4, "tool-error": 3, "release-proof": 3, "runtime-proof": 2, "environment-change": 2 }[signal] ?? 1), 0);
        return { pathHash: row.path_hash, provider: row.provider, sourceName: row.source_name, sizeBytes: row.size_bytes, modifiedAt: row.modified_at, signals, score };
      })
      .sort((a, b) => b.score - a.score || b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, limit);
  }

  createRun(record: RunRecord) {
    this.db
      .prepare("INSERT INTO runs (id, mode, executor, status, task_json, metrics_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, record.mode, record.executor, record.status, JSON.stringify(record.task), JSON.stringify(record.metrics), record.createdAt);
  }

  appendRunEvent(event: RunEvent) {
    this.db
      .prepare("INSERT OR REPLACE INTO run_events (run_id, sequence, body_json) VALUES (?, ?, ?)")
      .run(event.runId, event.sequence, JSON.stringify(event));
  }

  completeRun(id: string, status: "completed" | "failed", metrics: Record<string, RunMetrics>) {
    this.db.prepare("UPDATE runs SET status = ?, metrics_json = ? WHERE id = ?").run(status, JSON.stringify(metrics), id);
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      mode: row.mode as RunRecord["mode"],
      executor: row.executor as RunRecord["executor"],
      status: row.status as RunRecord["status"],
      task: JSON.parse(String(row.task_json)) as Record<string, unknown>,
      metrics: JSON.parse(String(row.metrics_json)) as Record<string, RunMetrics>,
      createdAt: String(row.created_at),
    };
  }

  getRunEvents(id: string, after = -1): RunEvent[] {
    const rows = this.db
      .prepare("SELECT body_json FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence")
      .all(id, after) as Array<{ body_json: string }>;
    return rows.map((row) => JSON.parse(row.body_json) as RunEvent);
  }

  savePolicy(policy: RetrievalPolicy) {
    this.db
      .prepare("INSERT OR REPLACE INTO policies (id, version, status, body_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(policy.id, policy.version, policy.status, JSON.stringify(policy), policy.createdAt);
  }

  getPolicies(): RetrievalPolicy[] {
    const rows = this.db.prepare("SELECT status, body_json FROM policies ORDER BY version DESC").all() as Array<{ status: RetrievalPolicy["status"]; body_json: string }>;
    return rows.map((row) => ({ ...(JSON.parse(row.body_json) as RetrievalPolicy), status: row.status }));
  }

  getActivePolicy(): RetrievalPolicy | null {
    const row = this.db.prepare("SELECT status, body_json FROM policies WHERE status = 'active' ORDER BY version DESC LIMIT 1").get() as { status: RetrievalPolicy["status"]; body_json: string } | undefined;
    return row ? { ...(JSON.parse(row.body_json) as RetrievalPolicy), status: row.status } : null;
  }

  activatePolicy(id: string) {
    this.db.exec("BEGIN");
    try {
      const rows = this.db
        .prepare("SELECT id, body_json FROM policies WHERE status = 'active' OR id = ?")
        .all(id) as Array<{ id: string; body_json: string }>;
      if (!rows.some((row) => row.id === id)) throw new Error(`Policy ${id} does not exist.`);
      const update = this.db.prepare("UPDATE policies SET status = ?, body_json = ? WHERE id = ?");
      for (const row of rows) {
        const status = row.id === id ? "active" : "rejected";
        const body = { ...(JSON.parse(row.body_json) as RetrievalPolicy), status };
        update.run(status, JSON.stringify(body), row.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveEvaluation(id: string, policyId: string, body: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO evaluations (id, policy_id, body_json) VALUES (?, ?, ?)").run(id, policyId, JSON.stringify(body));
  }
}
