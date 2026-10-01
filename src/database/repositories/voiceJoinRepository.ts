import { and, eq, lte } from "drizzle-orm";
import type { Database } from "../client.js";
import { voiceJoinRequests, type VoiceJoinRequestRow } from "../schema/voiceJoins.js";
import type { VoiceOverrides } from "../../modules/voice/voiceSettings.js";

/**
 * Repository for `voice_join_requests` (/mari-join). Thin and individually
 * idempotent, like its siblings; the decision of WHEN to act lives in
 * worker/voice.ts (`decideJoin`), which is pure and unit-tested.
 */
export class VoiceJoinRepository {
  constructor(private readonly db: Database) {}

  /**
   * Stores the new request and cancels any request still waiting for this
   * guild, in one transaction, so there is never more than one PENDING row
   * (the partial unique index enforces it too). Returns the request it replaced.
   */
  async schedule(params: { guildId: string; channelId: string; joinAt: Date; requestedBy: string } & VoiceOverrides): Promise<{ request: VoiceJoinRequestRow; replaced: VoiceJoinRequestRow | null }> {
    return this.db.transaction(async (tx) => {
      const [replaced] = await tx
        .update(voiceJoinRequests)
        .set({ status: "CANCELLED", handledAt: new Date() })
        .where(and(eq(voiceJoinRequests.guildId, params.guildId), eq(voiceJoinRequests.status, "PENDING")))
        .returning();
      const [request] = await tx.insert(voiceJoinRequests).values(params).returning();
      if (!request) throw new Error("Failed to insert voice_join_request");
      return { request, replaced: replaced ?? null };
    });
  }

  /** PENDING requests whose join time has arrived (the worker decides whether to act, wait, or expire them). */
  async listDue(guildId: string, now: Date): Promise<VoiceJoinRequestRow[]> {
    return this.db
      .select()
      .from(voiceJoinRequests)
      .where(and(eq(voiceJoinRequests.guildId, guildId), eq(voiceJoinRequests.status, "PENDING"), lte(voiceJoinRequests.joinAt, now)))
      .orderBy(voiceJoinRequests.joinAt);
  }

  async getPending(guildId: string): Promise<VoiceJoinRequestRow | undefined> {
    const rows = await this.db
      .select()
      .from(voiceJoinRequests)
      .where(and(eq(voiceJoinRequests.guildId, guildId), eq(voiceJoinRequests.status, "PENDING")))
      .limit(1);
    return rows[0];
  }

  /** Atomic PENDING -> CLAIMED. Returns false if another tick/process already took it (plan section 50). */
  async claim(id: number): Promise<boolean> {
    const rows = await this.db
      .update(voiceJoinRequests)
      .set({ status: "CLAIMED" })
      .where(and(eq(voiceJoinRequests.id, id), eq(voiceJoinRequests.status, "PENDING")))
      .returning({ id: voiceJoinRequests.id });
    return rows.length > 0;
  }

  /** Ends a request. Only a PENDING or CLAIMED one can be finished, so a finished row is never rewritten. */
  async finish(id: number, status: "DONE" | "FAILED" | "EXPIRED"): Promise<void> {
    await this.db
      .update(voiceJoinRequests)
      .set({ status, handledAt: new Date() })
      .where(and(eq(voiceJoinRequests.id, id), eq(voiceJoinRequests.status, status === "EXPIRED" ? "PENDING" : "CLAIMED")));
  }
}
