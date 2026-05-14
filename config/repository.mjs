import { logger } from "../logger.mjs";

export class Repository {
  constructor(db) {
    this.db = db;
  }

  // ────────────────────────────────────────────────────────────────
  // Session
  // ────────────────────────────────────────────────────────────────

  async getAccessToken(shopDomain) {
    if (!shopDomain) {
      logger.warn("getAccessToken", { message: "No shopDomain provided" });
      return null;
    }

    const result = await this.db.query(
      `SELECT "accessToken" FROM "Session" WHERE "shop" = $1 LIMIT 1`,
      [shopDomain]
    );

    if (!result?.rows?.length) {
      logger.error("getAccessToken", {
        step: "RETRIEVE_DB_SESSION",
        shopDomain,
        message: "Session not found — invalid shop or app uninstalled",
      });
      return null;
    }

    return result.rows[0].accessToken;
  }

  // ────────────────────────────────────────────────────────────────
  // Migrations — find / update
  // ────────────────────────────────────────────────────────────────

  // Find migration by ANY of 3 bulkOp columns + shop check.
  // Used by webhook to identify migration regardless of phase.
  async findMigrationByBulkOpId(bulkOperationId, shopDomain) {
    console.log("findMigrationByBulkOpId", { bulkOperationId, shopDomain })
    if (!bulkOperationId || !shopDomain) {
      logger.warn("findMigrationByBulkOpId", { message: "missing bulkOperationId or shopDomain" });
      return null;
    }

    const result = await this.db.query(
      `SELECT *
       FROM "Migrations"
       WHERE "shopId" = $2
         AND (
           "bulkOperationId"        = $1
           OR "rollbackCancelBulkOpId" = $1
           OR "rollbackRevokeBulkOpId" = $1
         )
       LIMIT 1`,
      [bulkOperationId, shopDomain]
    );

    return result.rows[0] || null;
  }

  // Update migration row counts (create phase)
  async updateMigrationCounts(migrationId, createdRows, failedRows, status = null) {
    if (status) {
      await this.db.query(
        `UPDATE "Migrations"
         SET "createdRows" = "createdRows" + $1,
             "failedRows"  = "failedRows"  + $2,
             "status"      = $3,
             "updatedAt"   = NOW()
         WHERE "migrationId" = $4`,
        [createdRows, failedRows, status, migrationId]
      );
    } else {
      await this.db.query(
        `UPDATE "Migrations"
         SET "createdRows" = "createdRows" + $1,
             "failedRows"  = "failedRows"  + $2,
             "updatedAt"   = NOW()
         WHERE "migrationId" = $3`,
        [createdRows, failedRows, migrationId]
      );
    }
  }

  // Update migration status only (used for finalize / failure)
  async updateMigrationStatus(migrationId, status) {
    await this.db.query(
      `UPDATE "Migrations"
       SET "status" = $1, "updatedAt" = NOW()
       WHERE "migrationId" = $2`,
      [status, migrationId]
    );
    logger.info("updateMigrationStatus", { migrationId, status });
  }

  // ────────────────────────────────────────────────────────────────
  // MigrationSubscriptions — eligibility fetchers (rollback)
  // ────────────────────────────────────────────────────────────────

  // Used by Cancel webhook — re-fetch in same order as Express worker
  // for __lineNumber index match
  async getCancelEligible(migrationId) {
    const result = await this.db.query(
      `SELECT id,
              "shopifySubscriptionId",
              "shopifyPaymentMethodId",
              "migrationStatus",
              "jsonlLineNumber"
       FROM "MigrationSubscriptions"
       WHERE "migrationId" = $1
         AND "shopifySubscriptionId" IS NOT NULL
         AND "migrationStatus" NOT IN (
           'rolled_back'::"MigrationSubscriptionStatus"
         )
       ORDER BY "jsonlLineNumber" ASC`,
      [migrationId]
    );
    return result.rows;
  }

  // Used by Revoke webhook — deduped paymentIds + paymentId → [subIds] map
  async getRevokeMap(migrationId) {
    const result = await this.db.query(
      `SELECT id,
            "shopifyPaymentMethodId",
            "jsonlLineNumber"
     FROM "MigrationSubscriptions"
     WHERE "migrationId" = $1
       AND "migrationStatus" = 'rollback_cancelled'::"MigrationSubscriptionStatus"
       AND "shopifyPaymentMethodId" IS NOT NULL
     ORDER BY "jsonlLineNumber" ASC`,
      [migrationId]
    );

    const seen = new Set();
    const paymentIds = [];
    const subsByPaymentId = new Map();

    for (const row of result.rows) {
      if (!seen.has(row.shopifyPaymentMethodId)) {
        seen.add(row.shopifyPaymentMethodId);
        paymentIds.push(row.shopifyPaymentMethodId);
      }
      if (!subsByPaymentId.has(row.shopifyPaymentMethodId)) {
        subsByPaymentId.set(row.shopifyPaymentMethodId, []);
      }
      subsByPaymentId.get(row.shopifyPaymentMethodId).push(row.id);
    }

    return { paymentIds, subsByPaymentId };
  }

  // ────────────────────────────────────────────────────────────────
  // MigrationSubscriptions — bulk updates (UNNEST pattern)
  // ────────────────────────────────────────────────────────────────

  // CREATE phase — update by jsonlLineNumber
  async bulkUpdateByLineNumbers(migrationId, updates) {
    if (!updates?.length) return 0;

    const lineNumbers = updates.map((u) => u.lineNumber);
    const migrationStatuses = updates.map((u) => u.migrationStatus);
    const shopifySubIds = updates.map((u) => u.shopifySubscriptionId || null);
    const errorMessages = updates.map((u) => u.errorMessage || null);

    // 🔍 Debug Logs
    console.log("--- DEBUG: bulkUpdateByLineNumbers ---");
    console.log("Migration ID:", migrationId);
    console.log("Line Numbers:", lineNumbers);
    console.log("Statuses (Check if these match Enum):", migrationStatuses);
    console.log("--------------------------------------");

    const result = await this.db.query(
      `UPDATE "MigrationSubscriptions" AS ms
       SET
         "migrationStatus"       = data.ms,
         "shopifySubscriptionId" = data.sid,
         "errorMessage"          = data.em,
         "updatedAt"             = NOW()
       FROM UNNEST(
         $1::int[], 
         $2::"MigrationSubscriptionStatus"[], 
         $3::text[], 
         $4::text[]
       ) AS data(ln, ms, sid, em)
       WHERE ms."migrationId"     = $5
       AND   ms."jsonlLineNumber" = data.ln`,
      [lineNumbers, migrationStatuses, shopifySubIds, errorMessages, migrationId]
    );

    logger.info("bulkUpdateByLineNumbers", {
      migrationId,
      totalUpdates: updates.length,
      rowsAffected: result.rowCount,
    });
    return result.rowCount;
  }

  // ⚠️ CRITICAL: Apply the same fix here to prevent future "Type Mismatch" errors
  // ROLLBACK CANCEL phase — update by jsonlLineNumber with full error fields
  // ROLLBACK CANCEL phase — update by jsonlLineNumber with full error fields.
  // Success → migrationStatus = "rollback_cancelled"
  // Failure → migrationStatus = "creation_failed" (or keep a dedicated failed status)
  async bulkUpdateCancelByLineNumbers(migrationId, updates) {
    if (!updates?.length) return 0;

    const lineNumbers = updates.map((u) => u.lineNumber);
    const migrationStatuses = updates.map((u) => u.migrationStatus);
    const errorCodes = updates.map((u) => u.errorCode || null);
    const errorMessages = updates.map((u) => u.errorMessage || null);
    const errorDetails = updates.map((u) => u.errorDetails ? JSON.stringify(u.errorDetails) : null);

    const result = await this.db.query(
      `UPDATE "MigrationSubscriptions" AS ms
     SET
       "migrationStatus" = data.ms,
       "errorCode"       = data.ec,
       "errorMessage"    = data.em,
       "errorDetails"    = CASE WHEN data.ed IS NULL THEN NULL ELSE data.ed::jsonb END,
       "updatedAt"       = NOW()
     FROM UNNEST(
       $1::int[],
       $2::"MigrationSubscriptionStatus"[],
       $3::text[],
       $4::text[],
       $5::text[]
     ) AS data(ln, ms, ec, em, ed)
     WHERE ms."migrationId"     = $6
     AND   ms."jsonlLineNumber" = data.ln`,
      [lineNumbers, migrationStatuses, errorCodes, errorMessages, errorDetails, migrationId]
    );

    logger.info("bulkUpdateCancelByLineNumbers", {
      migrationId,
      totalUpdates: updates.length,
      rowsAffected: result.rowCount,
    });
    return result.rowCount;
  }

  // ROLLBACK REVOKE phase — update by shopifyPaymentMethodId
  // (multiple subs can share one paymentId — single update affects all)
  // For success: migrationStatus = "deleted"
  // For failure: keep migrationStatus = "rollback_cancelled" (use COALESCE — pass null)
  async bulkUpdateRevokeByPaymentIds(migrationId, updates) {
    if (!updates?.length) return 0;

    const paymentIds = updates.map((u) => u.paymentMethodId);
    const migrationStatuses = updates.map((u) => u.migrationStatus || null);
    const errorCodes = updates.map((u) => u.errorCode || null);
    const errorMessages = updates.map((u) => u.errorMessage || null);
    const errorDetails = updates.map((u) => u.errorDetails ? JSON.stringify(u.errorDetails) : null);

    const result = await this.db.query(
      `UPDATE "MigrationSubscriptions" AS ms
       SET
         "migrationStatus" = COALESCE(data.ms, ms."migrationStatus"),
         "errorCode"       = data.ec,
         "errorMessage"    = data.em,
         "errorDetails"    = CASE WHEN data.ed IS NULL THEN NULL ELSE data.ed::jsonb END,
         "updatedAt"       = NOW()
       FROM UNNEST(
         $1::text[],
         $2::"MigrationSubscriptionStatus"[],
         $3::text[],
         $4::text[],
         $5::text[]
       ) AS data(pid, ms, ec, em, ed)
       WHERE ms."migrationId"            = $6
       AND   ms."shopifyPaymentMethodId" = data.pid
       AND   ms."migrationStatus"        = 'rollback_cancelled'::"MigrationSubscriptionStatus"`,
      [paymentIds, migrationStatuses, errorCodes, errorMessages, errorDetails, migrationId]
    );

    logger.info("bulkUpdateRevokeByPaymentIds", {
      migrationId,
      totalUpdates: updates.length,
      rowsAffected: result.rowCount,
    });
    return result.rowCount;
  }
}
