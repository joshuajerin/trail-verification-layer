import { createHash } from "node:crypto";
import { Pool } from "pg";
import { TrailSchema, type ContextBundle, type EvidenceObservation } from "@trail/contracts";
import { TrailDatabase } from "./database.js";

/**
 * Durable hosted storage for reviewed knowledge and non-raw routing metadata.
 * The router keeps a short-lived local session cache only so recovery can use
 * the exact current request without putting that request into Postgres.
 */
export class HostedPostgresStore {
  private constructor(private readonly pool: Pool, private readonly collectionId: string) {}

  static async connect(connectionString: string) {
    if (!connectionString) return null;
    const pool = new Pool({ connectionString });
    const collection = await pool.query<{ id: string }>("SELECT id::text AS id FROM knowledge_collections WHERE slug = 'trail-reviewed' LIMIT 1");
    if (!collection.rows[0]) {
      await pool.end();
      throw new Error("TRAIL_POSTGRES_URL is configured but the reviewed corpus collection is missing. Run the TRAIL migration and seed script first.");
    }
    return new HostedPostgresStore(pool, collection.rows[0].id);
  }

  async hydrateApprovedRoutes(cache: TrailDatabase) {
    const result = await this.pool.query<{ contract: unknown }>("SELECT contract FROM agent_safe_trails");
    for (const row of result.rows) cache.upsertTrail(TrailSchema.parse(row.contract));
    return result.rows.length;
  }

  async recordBundle(bundle: ContextBundle) {
    const requestHash = createHash("sha256").update(bundle.originalPrompt).digest("hex");
    await this.pool.query(
      `INSERT INTO route_bundles (id, collection_id, parent_id, status, trigger, request_sha256, redacted_request, environment, compiled_context, recovery_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7::jsonb, NULL, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [bundle.id, this.collectionId, bundle.parentId, bundle.status, bundle.trigger, requestHash, JSON.stringify(bundle.environment), bundle.recoveryCount, bundle.createdAt],
    );
    for (const [rank, match] of bundle.matchedTrails.entries()) {
      await this.pool.query(
        `INSERT INTO routing_decisions (bundle_id, trail_id, decision, rank, score, reasons)
         VALUES ($1, $2, 'selected', $3, $4, $5::jsonb) ON CONFLICT DO NOTHING`,
        [bundle.id, match.id, rank + 1, match.score, JSON.stringify(match.reasons)],
      );
    }
    for (const match of bundle.rejectedTrails) {
      await this.pool.query(
        `INSERT INTO routing_decisions (bundle_id, trail_id, decision, rank, score, reasons)
         VALUES ($1, $2, 'rejected', NULL, NULL, $3::jsonb) ON CONFLICT DO NOTHING`,
        [bundle.id, match.id, JSON.stringify(match.reasons)],
      );
    }
  }

  async recordObservations(observations: EvidenceObservation[], revision?: string) {
    for (const observation of observations) {
      await this.pool.query(
        `INSERT INTO verification_observations (id, bundle_id, evidence_id, verifier, attestation, expected, observed, passed, revision, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
        [observation.id, observation.bundleId, observation.evidenceId, observation.verifier, observation.attestation, observation.expected, observation.observed, observation.passed, revision ?? null, observation.timestamp],
      );
    }
  }

  async close() {
    await this.pool.end();
  }
}
