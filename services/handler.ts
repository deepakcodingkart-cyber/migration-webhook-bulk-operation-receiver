import { logger } from "../logger.ts";
import {
  processJSONLResults,
  processCancelJSONLResults,
  processRevokeJSONLResults,
} from "./shopify.ts";
import type { Repository } from "../config/repository.ts";
import type {
  CreateUpdate,
  JSONLLine,
  Migration,
  MigrationId,
  PhaseResult,
} from "../types/index.ts";

// ────────────────────────────────────────────────────────────────
// PHASE 1: CREATE FINISH
// 1. Process JSONL → successes + failures
// 2. Bulk update subs by jsonlLineNumber
// 3. Update Migrations counts + final status
// ────────────────────────────────────────────────────────────────
export async function handleCreatePhase({
  repo,
  migration,
  lines,
}: {
  repo: Repository;
  migration: Migration;
  lines: JSONLLine[];
}): Promise<PhaseResult> {
  console.log("[handler:create] ▶ start →", { migrationId: migration.migrationId, lines: lines.length });
  logger.info("handleCreatePhase start", { migrationId: migration.migrationId });

  const { successes, failures } = processJSONLResults(lines);
  console.log("[handler:create] 1. parsed JSONL →", {
    successes: successes.length,
    failures: failures.length,
  });

  const updates: CreateUpdate[] = [
    ...successes.map((s) => ({
      lineNumber:            s.lineNumber,
      migrationStatus:       "created",
      shopifySubscriptionId: s.shopifySubscriptionId,
      errorMessage:          null,
    })),
    ...failures.map((f) => ({
      lineNumber:            f.lineNumber,
      migrationStatus:       "creation_failed",
      shopifySubscriptionId: null,
      errorMessage:          f.errorMessage,
    })),
  ];

  if (updates.length === 0) {
    console.log("[handler:create] ⏭  no updates to apply — done");
    logger.warn("handleCreatePhase: no updates to apply", { migrationId: migration.migrationId });
    return { phase: "create", successes: 0, failures: 0, finalStatus: null };
  }

  console.log("[handler:create] 2. bulk updating", updates.length, "subscriptions…");
  const rowsAffected = await repo.bulkUpdateByLineNumbers(migration.migrationId, updates);

  // ── Finalize migration status ──
  const finalStatus =
    failures.length === 0 && successes.length > 0
      ? "migration_done"
      : successes.length === 0
        ? "migration_failed"
        : "migration_partial";

  console.log("[handler:create] 3. updating migration counts → finalStatus:", finalStatus);
  await repo.updateMigrationCounts(
    migration.migrationId,
    successes.length,
    failures.length,
    finalStatus,
  );

  console.log("[handler:create] ✅ done →", {
    rowsAffected,
    successes: successes.length,
    failures: failures.length,
    finalStatus,
  });
  logger.info("handleCreatePhase done", {
    migrationId: migration.migrationId,
    rowsAffected,
    successes:   successes.length,
    failures:    failures.length,
    finalStatus,
  });

  return {
    phase:       "create",
    successes:   successes.length,
    failures:    failures.length,
    finalStatus,
  };
}

// ────────────────────────────────────────────────────────────────
// PHASE 2: ROLLBACK CANCEL FINISH
// 1. Re-fetch eligible subs (same order as Express worker)
// 2. Process JSONL → updates with __lineNumber match
// 3. Bulk update subs (rollback_cancelled / failed + error fields)
// 4. Branch:
//    - other_platform: trigger /rollback/revoke endpoint
//    - else:           finalize migration (rolled_back / rollback_partial)
// ────────────────────────────────────────────────────────────────
export async function handleRollbackCancelPhase({
  repo,
  migration,
  lines,
  shopDomain,
}: {
  repo: Repository;
  migration: Migration;
  lines: JSONLLine[];
  shopDomain: string;
}): Promise<PhaseResult> {
  console.log("[handler:rollback_cancel] ▶ start →", {
    migrationId: migration.migrationId,
    platformKey: migration.platformKey,
    lines: lines.length,
  });
  logger.info("handleRollbackCancelPhase start", {
    migrationId: migration.migrationId,
    platformKey: migration.platformKey,
  });

  // ── Re-fetch eligible — MUST mirror Express worker's order ──
  console.log("[handler:rollback_cancel] 1. re-fetching eligible subscriptions…");
  const eligible = await repo.getCancelEligible(migration.migrationId);
  console.log("[handler:rollback_cancel] 1. eligible re-fetched →", eligible.length);
  logger.info("handleRollbackCancelPhase: eligible re-fetched", {
    migrationId:    migration.migrationId,
    eligibleCount:  eligible.length,
    resultLines:    lines.length,
  });

  const isOtherPlatform     = migration.platformKey === "other_platform";
  // const successAfterStatus  = isOtherPlatform ? "rollback_cancelled" : "deleted";
  const successAfterStatus  = isOtherPlatform ? "rollback_cancelled" : "rolled_back";

  const { updates, successes, failures } = processCancelJSONLResults(
    lines,
    eligible,
    successAfterStatus,
  );
  console.log("[handler:rollback_cancel] 2. parsed JSONL →", {
    updates: updates.length,
    successes: successes.length,
    failures: failures.length,
  });

  if (updates.length > 0) {
    console.log("[handler:rollback_cancel] 3. bulk updating", updates.length, "cancel results…");
    await repo.bulkUpdateCancelByLineNumbers(migration.migrationId, updates);
  }

  // ── Branch: other_platform → trigger revoke; else → finalize ──
  if (isOtherPlatform && successes.length > 0) {
    try {
      console.log("[handler:rollback_cancel] 4. other_platform → triggering revoke endpoint…");
      await triggerRevokeEndpoint(migration.migrationId, shopDomain);
      console.log("[handler:rollback_cancel] ✅ revoke triggered");
      logger.info("handleRollbackCancelPhase: revoke triggered", {
        migrationId: migration.migrationId,
      });
      return {
        phase:     "rollback_cancel",
        successes: successes.length,
        failures:  failures.length,
        next:      "revoke_triggered",
      };
    } catch (err) {
      console.error("[handler:rollback_cancel] ❌ revoke trigger failed:", err);
      logger.error("handleRollbackCancelPhase: revoke trigger failed", {
        migrationId: migration.migrationId,
      }, err);
      await repo.updateMigrationStatus(migration.migrationId, "rollback_failed");
      return {
        phase:       "rollback_cancel",
        successes:   successes.length,
        failures:    failures.length,
        finalStatus: "rollback_failed",
        error:       (err as Error).message,
      };
    }
  }

  // ── Non-other_platform → finalize directly ──
  const finalStatus = failures.length === 0 ? "rolled_back" : "rollback_partial";
  console.log("[handler:rollback_cancel] 4. finalizing migration → status:", finalStatus);
  await repo.updateMigrationStatus(migration.migrationId, finalStatus);

  console.log("[handler:rollback_cancel] ✅ done →", {
    successes: successes.length,
    failures: failures.length,
    finalStatus,
  });
  logger.info("handleRollbackCancelPhase done", {
    migrationId: migration.migrationId,
    successes:   successes.length,
    failures:    failures.length,
    finalStatus,
  });

  return {
    phase:       "rollback_cancel",
    successes:   successes.length,
    failures:    failures.length,
    finalStatus,
  };
}

// ────────────────────────────────────────────────────────────────
// PHASE 3: ROLLBACK REVOKE FINISH
// 1. Re-fetch deduped paymentIds + subsByPaymentId map
// 2. Process JSONL → updates with __lineNumber → paymentId match
// 3. Bulk update by paymentMethodId (multiple subs share)
//    - success → migrationStatus = "deleted"
//    - failure → keep "rollback_cancelled" (COALESCE), errorCode set
// 4. Finalize migration (rolled_back / rollback_partial)
// ────────────────────────────────────────────────────────────────
export async function handleRollbackRevokePhase({
  repo,
  migration,
  lines,
}: {
  repo: Repository;
  migration: Migration;
  lines: JSONLLine[];
}): Promise<PhaseResult> {
  console.log("[handler:rollback_revoke] ▶ start →", {
    migrationId: migration.migrationId,
    lines: lines.length,
  });
  logger.info("handleRollbackRevokePhase start", { migrationId: migration.migrationId });

  // ── Re-fetch revoke map — MUST mirror Express worker dedup order ──
  console.log("[handler:rollback_revoke] 1. re-fetching revoke map…");
  const { paymentIds } = await repo.getRevokeMap(migration.migrationId);
  console.log("[handler:rollback_revoke] 1. paymentIds re-fetched →", paymentIds.length);
  logger.info("handleRollbackRevokePhase: paymentIds re-fetched", {
    migrationId:      migration.migrationId,
    paymentIdsCount:  paymentIds.length,
    resultLines:      lines.length,
  });

  const { updates, successes, failures } = processRevokeJSONLResults(lines, paymentIds);
  console.log("[handler:rollback_revoke] 2. parsed JSONL →", {
    updates: updates.length,
    successes: successes.length,
    failures: failures.length,
  });

  if (updates.length > 0) {
    console.log("[handler:rollback_revoke] 3. bulk updating", updates.length, "revoke results…");
    await repo.bulkUpdateRevokeByPaymentIds(migration.migrationId, updates);
  }

  // ── Finalize migration ──
  const finalStatus = failures.length === 0 ? "rolled_back" : "rollback_partial";
  console.log("[handler:rollback_revoke] 4. finalizing migration → status:", finalStatus);
  await repo.updateMigrationStatus(migration.migrationId, finalStatus);

  console.log("[handler:rollback_revoke] ✅ done →", {
    successes: successes.length,
    failures: failures.length,
    finalStatus,
  });
  logger.info("handleRollbackRevokePhase done", {
    migrationId: migration.migrationId,
    successes:   successes.length,
    failures:    failures.length,
    finalStatus,
  });

  return {
    phase:       "rollback_revoke",
    successes:   successes.length,
    failures:    failures.length,
    finalStatus,
  };
}

// ────────────────────────────────────────────────────────────────
// HTTP trigger — Express /v1/migration/rollback/revoke
// ────────────────────────────────────────────────────────────────
async function triggerRevokeEndpoint(
  migrationId: MigrationId,
  shopDomain: string,
): Promise<unknown> {
  const baseUrl = process.env.EXPRESS_URL;
  if (!baseUrl) {
    throw new Error("EXPRESS_URL env var not set — cannot trigger revoke");
  }

  const url = `${baseUrl}/v1/migration/rollback/revoke`;
  console.log("[handler] triggerRevokeEndpoint → POST", url, { migrationId, shopDomain });
  logger.info("triggerRevokeEndpoint", { url, migrationId, shopDomain });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ migrationId, shop: shopDomain }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[handler] triggerRevokeEndpoint → HTTP", res.status, text);
    throw new Error(`Revoke trigger HTTP ${res.status}: ${text}`);
  }

  const data = await res.json().catch(() => ({}));
  console.log("[handler] triggerRevokeEndpoint → response", { status: res.status });
  logger.info("triggerRevokeEndpoint response", { status: res.status, data });
  return data;
}
