import { and, eq, gt, lte } from "drizzle-orm";
import type { Db } from "@sudsnik/infra-db";
import { err, newId, ok, sudsnikError } from "@sudsnik/kernel";
import type { HoldStore } from "@sudsnik/contracts/services/washnodes";
import { firmwareRefOf, guardTransition, type StoredHold } from "../../domain/hold.js";
import { holds, washers } from "../db/schema.js";

type HoldRow = typeof holds.$inferSelect;
const asHold = (row: HoldRow): StoredHold => ({ ...row });
const expiredConflict = (holdId: string) => err(sudsnikError("CONFLICT", `hold ${holdId} has expired`));

export function sqliteHoldStore(db: Db): HoldStore {
  db.sqlite.transaction(() => {
    db.write(`update washers set state = 'idle', hold_id = null
      where state = 'held' and not exists (
        select 1 from holds where holds.hold_id = washers.hold_id and holds.state = 'held'
      )`);
  }).immediate();
  const find = (holdId: string) => {
    const row = db.orm.select().from(holds).where(eq(holds.holdId, holdId)).get();
    return row ? asHold(row) : undefined;
  };
  const transact = <T>(fn: () => T): T => db.sqlite.transaction(fn).immediate();
  const conflict = (holdId: string, version: number) => guardTransition(find(holdId), holdId, version);

  return {
    acquire: async (input) => {
      const ref = firmwareRefOf(input.firmwareRef, `hold for order ${input.orderId}`);
      if (!ref.ok) return ref;
      const hold: StoredHold = {
        holdId: input.holdId ?? newId(), tenantId: input.tenantId, nodeId: input.nodeId, washerId: input.washerId,
        orderId: input.orderId, state: "held", acquiredAt: input.nowMs, expiresAt: input.nowMs + input.ttlMs,
        version: 0, firmwareRef: ref.value,
      };
      return transact(() => {
        const claimed = db.orm.update(washers).set({ state: "held", holdId: hold.holdId })
          .where(and(eq(washers.washerId, input.washerId), eq(washers.state, "idle"), eq(washers.maintenance, false))).run().changes;
        const reserved = claimed === 1 || db.orm.select({ washerId: washers.washerId }).from(washers).where(and(
          eq(washers.washerId, input.washerId), eq(washers.state, "held"), eq(washers.holdId, hold.holdId),
        )).get() !== undefined;
        if (!reserved) return err(sudsnikError("CONFLICT", `washer ${input.washerId} is no longer reserved`));
        db.orm.insert(holds).values({ ...hold, endedAt: null, reason: null }).run();
        return ok(hold);
      });
    },
    release: async (holdId, version, reason, nowMs) => transact(() => {
      const current = find(holdId);
      const guarded = guardTransition(current, holdId, version);
      if (!guarded.ok) return guarded;
      const changed = db.orm.update(holds).set({ state: "released", version: version + 1, endedAt: nowMs, reason })
        .where(and(eq(holds.holdId, holdId), eq(holds.version, version), eq(holds.state, "held"))).run().changes;
      if (!changed) return conflict(holdId, version);
      db.orm.update(washers).set({ state: "idle", holdId: null })
        .where(and(eq(washers.washerId, guarded.value.washerId), eq(washers.holdId, holdId))).run();
      return ok({ ...guarded.value, state: "released", version: version + 1 });
    }),
    consume: async (holdId, version, nowMs) => transact(() => {
      const current = find(holdId);
      const guarded = guardTransition(current, holdId, version);
      if (!guarded.ok) return guarded;
      if (guarded.value.expiresAt <= nowMs) return expiredConflict(holdId);
      const changed = db.orm.update(holds).set({ state: "consumed", version: version + 1, endedAt: nowMs })
        .where(and(eq(holds.holdId, holdId), eq(holds.version, version), eq(holds.state, "held"), gt(holds.expiresAt, nowMs))).run().changes;
      if (!changed) return conflict(holdId, version);
      db.orm.update(washers).set({ state: "washing" })
        .where(and(eq(washers.washerId, guarded.value.washerId), eq(washers.holdId, holdId))).run();
      return ok({ ...guarded.value, state: "consumed", version: version + 1 });
    }),
    expire: async (nowMs, onExpired) => transact(() => {
      const due = db.orm.select().from(holds).where(and(eq(holds.state, "held"), lte(holds.expiresAt, nowMs))).all();
      const expired: StoredHold[] = [];
      for (const row of due) {
        const hold = asHold(row);
        const changed = db.orm.update(holds).set({ state: "expired", version: hold.version + 1, endedAt: nowMs })
          .where(and(eq(holds.holdId, hold.holdId), eq(holds.version, hold.version), eq(holds.state, "held"), lte(holds.expiresAt, nowMs))).run().changes;
        if (!changed) continue;
        db.orm.update(washers).set({ state: "idle", holdId: null })
          .where(and(eq(washers.washerId, hold.washerId), eq(washers.holdId, hold.holdId))).run();
        expired.push({ ...hold, state: "expired", version: hold.version + 1 });
      }
      onExpired?.(expired);
      return ok(expired);
    }),
    get: async (holdId) => {
      const hold = find(holdId);
      return hold ? ok(hold) : err(sudsnikError("NOT_FOUND", `no hold ${holdId}`));
    },
  };
}
