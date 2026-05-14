import { Prisma, PrismaClient } from "@prisma/client";
import type { MigrationStatus, MigrationSubscriptionStatus } from "@prisma/client";
import { logger } from "../logger.ts";
import type {
  CancelEligibleRow,
  CancelUpdate,
  CreateUpdate,
  Migration,
  MigrationId,
  RevokeMap,
  RevokeUpdate,
} from "../types/index.ts";

// The app writes some status values that are not part of the introspected
// Postgres enums (e.g. "rollback_cancelled", "failed", "deleted", "bulk_failed").
// The database accepts them, so we cast through the Prisma enum type to keep the
// typed client happy WITHOUT altering the values being written.
const asSubStatus = (v: string): MigrationSubscriptionStatus => v as MigrationSubscriptionStatus;
const asMigStatus = (v: string): MigrationStatus => v as MigrationStatus;

// All DB calls print `[db:<method>]` markers — query in, result out — so a
// failing run shows exactly which query ran last and what it returned.
export class Repository {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  // ────────────────────────────────────────────────────────────────
  // Session
  // ────────────────────────────────────────────────────────────────

  async getAccessToken(shopDomain: string): Promise<string | null> {
    if (!shopDomain) {
      logger.warn("getAccessToken", { message: "No shopDomain provided" });
      return null;
    }

    console.log("[db:getAccessToken] → Session.findFirst where shop =", shopDomain);
    const result = await this.prisma.session.findFirst({
      where: { shop: shopDomain },
      select: { accessToken: true },
    });
    console.log("[db:getAccessToken] ← found:", result ? "yes (token retrieved)" : "no");

    if (!result) {
      logger.error("getAccessToken", {
        step: "RETRIEVE_DB_SESSION",
        shopDomain,
        message: "Session not found — invalid shop or app uninstalled",
      });
      return null;
    }

    return result.accessToken;
  }

  // ────────────────────────────────────────────────────────────────
  // Migrations — find / update
  // ────────────────────────────────────────────────────────────────

  // Find migration by ANY of 3 bulkOp columns + shop check.
  // Used by webhook to identify migration regardless of phase.
  async findMigrationByBulkOpId(
    bulkOperationId: string,
    shopDomain: string,
  ): Promise<Migration | null> {
    if (!bulkOperationId || !shopDomain) {
      logger.warn("findMigrationByBulkOpId", { message: "missing bulkOperationId or shopDomain" });
      return null;
    }

    console.log("[db:findMigrationByBulkOpId] → Migrations.findFirst", { bulkOperationId, shopDomain });
    const result = await this.prisma.migrations.findFirst({
      where: {
        shopId: shopDomain,
        OR: [
          { bulkOperationId: bulkOperationId },
          { rollbackCancelBulkOpId: bulkOperationId },
          { rollbackRevokeBulkOpId: bulkOperationId },
        ],
      },
    });
    console.log(
      "[db:findMigrationByBulkOpId] ←",
      result
        ? { migrationId: result.migrationId, status: result.status, platformKey: result.platformKey }
        : "no match",
    );

    return (result as Migration | null) || null;
  }

  // Update migration row counts (create phase)
  async updateMigrationCounts(
    migrationId: MigrationId,
    createdRows: number,
    failedRows: number,
    status: string | null = null,
  ): Promise<void> {
    console.log("[db:updateMigrationCounts] → Migrations.update", {
      migrationId,
      createdRows,
      failedRows,
      status,
    });
    await this.prisma.migrations.update({
      where: { migrationId: migrationId as string },
      data: {
        createdRows: { increment: createdRows },
        failedRows: { increment: failedRows },
        ...(status ? { status: asMigStatus(status) } : {}),
        updatedAt: new Date(),
      },
    });
    console.log("[db:updateMigrationCounts] ← done");
  }

  // Update migration status only (used for finalize / failure)
  async updateMigrationStatus(migrationId: MigrationId, status: string): Promise<void> {
    console.log("[db:updateMigrationStatus] → Migrations.update", { migrationId, status });
    await this.prisma.migrations.update({
      where: { migrationId: migrationId as string },
      data: { status: asMigStatus(status), updatedAt: new Date() },
    });
    console.log("[db:updateMigrationStatus] ← done");
    logger.info("updateMigrationStatus", { migrationId, status });
  }

  // ────────────────────────────────────────────────────────────────
  // MigrationSubscriptions — eligibility fetchers (rollback)
  // ────────────────────────────────────────────────────────────────

  // Used by Cancel webhook — re-fetch in same order as Express worker
  // for __lineNumber index match
  async getCancelEligible(migrationId: MigrationId): Promise<CancelEligibleRow[]> {
    console.log("[db:getCancelEligible] → MigrationSubscriptions.findMany", { migrationId });
    const result = await this.prisma.migrationSubscriptions.findMany({
      where: {
        migrationId: migrationId as string,
        shopifySubscriptionId: { not: null },
        migrationStatus: { not: asSubStatus("rolled_back") },
      },
      orderBy: { jsonlLineNumber: "asc" },
      select: {
        id: true,
        shopifySubscriptionId: true,
        shopifyPaymentMethodId: true,
        migrationStatus: true,
        jsonlLineNumber: true,
      },
    });
    console.log("[db:getCancelEligible] ←", result.length, "eligible rows");
    return result as CancelEligibleRow[];
  }

  // Used by Revoke webhook — deduped paymentIds + paymentId → [subIds] map
  async getRevokeMap(migrationId: MigrationId): Promise<RevokeMap> {
    console.log("[db:getRevokeMap] → MigrationSubscriptions.findMany", { migrationId });
    const result = await this.prisma.migrationSubscriptions.findMany({
      where: {
        migrationId: migrationId as string,
        migrationStatus: asSubStatus("rollback_cancelled"),
        // "shopifyPaymentMethodId" is NOT NULL in the schema, so the original
        // `IS NOT NULL` guard is implicit here.
      },
      orderBy: { jsonlLineNumber: "asc" },
      select: {
        id: true,
        shopifyPaymentMethodId: true,
        jsonlLineNumber: true,
      },
    });

    const seen = new Set<string>();
    const paymentIds: string[] = [];
    const subsByPaymentId = new Map<string, MigrationId[]>();

    for (const row of result) {
      if (!seen.has(row.shopifyPaymentMethodId)) {
        seen.add(row.shopifyPaymentMethodId);
        paymentIds.push(row.shopifyPaymentMethodId);
      }
      if (!subsByPaymentId.has(row.shopifyPaymentMethodId)) {
        subsByPaymentId.set(row.shopifyPaymentMethodId, []);
      }
      subsByPaymentId.get(row.shopifyPaymentMethodId)!.push(row.id);
    }

    console.log("[db:getRevokeMap] ←", {
      rows: result.length,
      uniquePaymentIds: paymentIds.length,
    });
    return { paymentIds, subsByPaymentId };
  }

  // ────────────────────────────────────────────────────────────────
  // MigrationSubscriptions — bulk updates
  // The original raw SQL did one `UPDATE ... FROM UNNEST(...)` statement.
  // With Prisma we run a `$transaction` of per-row `updateMany` calls — the
  // whole batch still commits atomically, and rowsAffected is the sum.
  // ────────────────────────────────────────────────────────────────

  // CREATE phase — update by jsonlLineNumber
  async bulkUpdateByLineNumbers(
    migrationId: MigrationId,
    updates: CreateUpdate[],
  ): Promise<number | null> {
    if (!updates?.length) {
      console.log("[db:bulkUpdateByLineNumbers] ⏭  no updates — skipping");
      return 0;
    }

    console.log("[db:bulkUpdateByLineNumbers] → $transaction of", updates.length, "updateMany", {
      migrationId,
      lineNumbers: updates.map((u) => u.lineNumber),
      statuses: updates.map((u) => u.migrationStatus),
    });

    const results = await this.prisma.$transaction(
      updates.map((u) =>
        this.prisma.migrationSubscriptions.updateMany({
          where: { migrationId: migrationId as string, jsonlLineNumber: u.lineNumber },
          data: {
            migrationStatus: asSubStatus(u.migrationStatus),
            shopifySubscriptionId: u.shopifySubscriptionId || null,
            errorMessage: u.errorMessage || null,
            updatedAt: new Date(),
          },
        }),
      ),
    );

    const rowsAffected = results.reduce((sum, r) => sum + r.count, 0);
    console.log("[db:bulkUpdateByLineNumbers] ← rowsAffected:", rowsAffected);

    logger.info("bulkUpdateByLineNumbers", {
      migrationId,
      totalUpdates: updates.length,
      rowsAffected,
    });
    return rowsAffected;
  }

  // ROLLBACK CANCEL phase — update by jsonlLineNumber with full error fields.
  async bulkUpdateCancelByLineNumbers(
    migrationId: MigrationId,
    updates: CancelUpdate[],
  ): Promise<number | null> {
    if (!updates?.length) {
      console.log("[db:bulkUpdateCancelByLineNumbers] ⏭  no updates — skipping");
      return 0;
    }

    console.log(
      "[db:bulkUpdateCancelByLineNumbers] → $transaction of",
      updates.length,
      "updateMany",
      { migrationId },
    );

    const results = await this.prisma.$transaction(
      updates.map((u) =>
        this.prisma.migrationSubscriptions.updateMany({
          where: { migrationId: migrationId as string, jsonlLineNumber: u.lineNumber },
          data: {
            migrationStatus: asSubStatus(u.migrationStatus),
            errorCode: u.errorCode || null,
            errorMessage: u.errorMessage || null,
            errorDetails:
              u.errorDetails === null
                ? Prisma.DbNull
                : (u.errorDetails as Prisma.InputJsonValue),
            updatedAt: new Date(),
          },
        }),
      ),
    );

    const rowsAffected = results.reduce((sum, r) => sum + r.count, 0);
    console.log("[db:bulkUpdateCancelByLineNumbers] ← rowsAffected:", rowsAffected);

    logger.info("bulkUpdateCancelByLineNumbers", {
      migrationId,
      totalUpdates: updates.length,
      rowsAffected,
    });
    return rowsAffected;
  }

  // ROLLBACK REVOKE phase — update by shopifyPaymentMethodId
  // (multiple subs can share one paymentId — single update affects all)
  // For success: migrationStatus = "deleted"
  // For failure: keep migrationStatus = "rollback_cancelled" (use COALESCE — pass null)
  async bulkUpdateRevokeByPaymentIds(
    migrationId: MigrationId,
    updates: RevokeUpdate[],
  ): Promise<number | null> {
    if (!updates?.length) {
      console.log("[db:bulkUpdateRevokeByPaymentIds] ⏭  no updates — skipping");
      return 0;
    }

    console.log(
      "[db:bulkUpdateRevokeByPaymentIds] → $transaction of",
      updates.length,
      "updateMany",
      { migrationId },
    );

    const results = await this.prisma.$transaction(
      updates.map((u) =>
        this.prisma.migrationSubscriptions.updateMany({
          where: {
            migrationId: migrationId as string,
            shopifyPaymentMethodId: u.paymentMethodId,
            migrationStatus: asSubStatus("rollback_cancelled"),
          },
          data: {
            // null migrationStatus = keep the current value (original used COALESCE).
            ...(u.migrationStatus !== null
              ? { migrationStatus: asSubStatus(u.migrationStatus) }
              : {}),
            errorCode: u.errorCode || null,
            errorMessage: u.errorMessage || null,
            errorDetails:
              u.errorDetails === null
                ? Prisma.DbNull
                : (u.errorDetails as Prisma.InputJsonValue),
            updatedAt: new Date(),
          },
        }),
      ),
    );

    const rowsAffected = results.reduce((sum, r) => sum + r.count, 0);
    console.log("[db:bulkUpdateRevokeByPaymentIds] ← rowsAffected:", rowsAffected);

    logger.info("bulkUpdateRevokeByPaymentIds", {
      migrationId,
      totalUpdates: updates.length,
      rowsAffected,
    });
    return rowsAffected;
  }
}
