import { logger } from "../logger.mjs";
import {
  processJSONLResults,
  processCancelJSONLResults,
  processRevokeJSONLResults,
} from "./shopify.mjs";

// ────────────────────────────────────────────────────────────────
// PHASE 1: CREATE FINISH
// 1. Process JSONL → successes + failures
// 2. Bulk update subs by jsonlLineNumber
// 3. Update Migrations counts + final status
// ────────────────────────────────────────────────────────────────
export async function handleCreatePhase({ repo, migration, lines }) {
  logger.info("handleCreatePhase start", { migrationId: migration.migrationId });

  const { successes, failures } = processJSONLResults(lines);

  const updates = [
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
    logger.warn("handleCreatePhase: no updates to apply", { migrationId: migration.migrationId });
    return { phase: "create", successes: 0, failures: 0, finalStatus: null };
  }

  const rowsAffected = await repo.bulkUpdateByLineNumbers(migration.migrationId, updates);

  // ── Finalize migration status ──
  const finalStatus =
    failures.length === 0 && successes.length > 0
      ? "migration_done"
      : successes.length === 0
        ? "migration_failed"
        : "migration_partial";

  await repo.updateMigrationCounts(
    migration.migrationId,
    successes.length,
    failures.length,
    finalStatus,
  );

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
export async function handleRollbackCancelPhase({ repo, migration, lines, shopDomain }) {
  logger.info("handleRollbackCancelPhase start", {
    migrationId: migration.migrationId,
    platformKey: migration.platformKey,
  });

  // ── Re-fetch eligible — MUST mirror Express worker's order ──
  const eligible = await repo.getCancelEligible(migration.migrationId);
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

  if (updates.length > 0) {
    await repo.bulkUpdateCancelByLineNumbers(migration.migrationId, updates);
  }

  // ── Branch: other_platform → trigger revoke; else → finalize ──
  if (isOtherPlatform && successes.length > 0) {
    try {
      await triggerRevokeEndpoint(migration.migrationId, shopDomain);
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
      logger.error("handleRollbackCancelPhase: revoke trigger failed", {
        migrationId: migration.migrationId,
      }, err);
      await repo.updateMigrationStatus(migration.migrationId, "rollback_failed");
      return {
        phase:       "rollback_cancel",
        successes:   successes.length,
        failures:    failures.length,
        finalStatus: "rollback_failed",
        error:       err.message,
      };
    }
  }

  // ── Non-other_platform → finalize directly ──
  const finalStatus = failures.length === 0 ? "rolled_back" : "rollback_partial";
  await repo.updateMigrationStatus(migration.migrationId, finalStatus);

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
export async function handleRollbackRevokePhase({ repo, migration, lines }) {
  logger.info("handleRollbackRevokePhase start", { migrationId: migration.migrationId });

  // ── Re-fetch revoke map — MUST mirror Express worker dedup order ──
  const { paymentIds } = await repo.getRevokeMap(migration.migrationId);
  logger.info("handleRollbackRevokePhase: paymentIds re-fetched", {
    migrationId:      migration.migrationId,
    paymentIdsCount:  paymentIds.length,
    resultLines:      lines.length,
  });

  const { updates, successes, failures } = processRevokeJSONLResults(lines, paymentIds);

  if (updates.length > 0) {
    await repo.bulkUpdateRevokeByPaymentIds(migration.migrationId, updates);
  }

  // ── Finalize migration ──
  const finalStatus = failures.length === 0 ? "rolled_back" : "rollback_partial";
  await repo.updateMigrationStatus(migration.migrationId, finalStatus);

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
async function triggerRevokeEndpoint(migrationId, shopDomain) {
  const baseUrl = process.env.EXPRESS_URL;
  if (!baseUrl) {
    throw new Error("EXPRESS_URL env var not set — cannot trigger revoke");
  }

  const url = `${baseUrl}/v1/migration/rollback/revoke`;
  logger.info("triggerRevokeEndpoint", { url, migrationId, shopDomain });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ migrationId, shop: shopDomain }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Revoke trigger HTTP ${res.status}: ${text}`);
  }

  const data = await res.json().catch(() => ({}));
  logger.info("triggerRevokeEndpoint response", { status: res.status, data });
  return data;
}
