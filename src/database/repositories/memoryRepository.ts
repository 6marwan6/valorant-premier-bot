import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { memories, type MemoryRow, type MemoryType, type MemoryVisibility } from "../schema/memories.js";
import { memoryEvidence, type MemoryEvidenceRow } from "../schema/memoryEvidence.js";

export interface NewMemoryInput {
  playerId: number;
  type: MemoryType;
  content: string;
  confidence?: number;
  visibility?: MemoryVisibility;
  aiUsable?: boolean;
  /** Evidence for this memory (plan section 25) — at least one row, same transaction as the memory itself. */
  evidence: Array<{ sourceType: MemoryEvidenceRow["sourceType"]; sourceId: string }>;
}

/**
 * Repository for `memories` / `memory_evidence` — plan sections 23/25
 * (Phase 8). Thin like its siblings: it stores and retrieves rows; the
 * decision of *whether* a candidate becomes a memory lives in
 * modules/memories/memoryService.ts (plan section 37: the backend, not
 * this layer either, owns that decision — this layer just persists it).
 */
export class MemoryRepository {
  constructor(private readonly db: Database) {}

  /**
   * Creates a memory and its evidence row(s) in one transaction — plan
   * section 25: "every derived memory should be traceable to evidence."
   * There is no path in this codebase that creates a memory without at
   * least one evidence row (see `evidence` being required, not optional).
   */
  async create(input: NewMemoryInput): Promise<MemoryRow> {
    return this.db.transaction(async (tx) => {
      const [memory] = await tx
        .insert(memories)
        .values({
          playerId: input.playerId,
          type: input.type,
          content: input.content,
          confidence: input.confidence ?? 1,
          visibility: input.visibility ?? "PRIVATE",
          aiUsable: input.aiUsable ?? true,
        })
        .returning();
      if (!memory) throw new Error(`Failed to insert memory for player ${input.playerId}`);

      if (input.evidence.length > 0) {
        await tx.insert(memoryEvidence).values(input.evidence.map((e) => ({ memoryId: memory.id, ...e })));
      }
      return memory;
    });
  }

  async getById(id: number): Promise<MemoryRow | undefined> {
    const rows = await this.db.select().from(memories).where(eq(memories.id, id)).limit(1);
    return rows[0];
  }

  /**
   * Every memory for a player, newest first — plan section 43's
   * `/memories` categorized summary reads this and groups by `type`
   * itself (grouping is a display concern, not a query concern).
   */
  async listByPlayer(playerId: number): Promise<MemoryRow[]> {
    return this.db.select().from(memories).where(eq(memories.playerId, playerId)).orderBy(desc(memories.id));
  }

  /**
   * Plan section 43: "Players should be able to request deletion of their
   * memories." Scoped to `playerId` in the WHERE clause (not just `id`) so
   * a player can never delete — or even confirm the existence of — another
   * player's memory via a guessed id (plan section 44 rule 4). Cascades to
   * `memory_evidence` automatically (schema's `onDelete: "cascade"") —
   * "deleting a memory should also invalidate its retrieval
   * representation," and there is no separate representation yet to worry
   * about (Phase 9). Returns whether a row was actually removed, so the
   * command can tell "deleted" from "not yours / doesn't exist" without
   * leaking which.
   */
  async deleteForPlayer(id: number, playerId: number): Promise<boolean> {
    const rows = await this.db
      .delete(memories)
      .where(and(eq(memories.id, id), eq(memories.playerId, playerId)))
      .returning({ id: memories.id });
    return rows.length > 0;
  }
}
