import {
  fetchBulkOperationDetails,
  downloadAndParseJSONL,
} from "./shopify.ts";
import {
  handleCreatePhase,
  handleRollbackCancelPhase,
  handleRollbackRevokePhase,
} from "./handler.ts";
import { detectPhase } from "../utils/helper.ts";
import { getHeader } from "../utils/webhook.ts";
import type { Repository } from "../config/repository.ts";
import type {
  BulkOperationNode,
  JSONLLine,
  LambdaEvent,
  Logger,
  Migration,
  PhaseResult,
  ShopifyWebhookPayload,
} from "../types/index.ts";

// ─────────────────────────────────────────────────────────────
// Background work — every external/db call is wrapped so we can
// log + tag the failing step before bubbling up.
//
// The `[processWebhook] N. …` console markers are printed BEFORE
// each risky operation: when something throws, the LAST marker on
// screen tells you exactly which step failed.
// ─────────────────────────────────────────────────────────────
export async function processWebhook({
  repo,
  event,
  log,
}: {
  repo: Repository;
  event: LambdaEvent;
  log: Logger;
}): Promise<void> {
  console.log("\n[processWebhook] ━━━━━━━━━ START ━━━━━━━━━");

  // ── Headers (real Shopify webhook delivers shop + topic via headers) ──
  const topic = getHeader(event.headers, "x-shopify-topic") || "";
  const shopDomain = getHeader(event.headers, "x-shopify-shop-domain") || "";
  console.log("[processWebhook] 1. headers →", { topic, shopDomain });

  // ── Parse body ──
  let payload: ShopifyWebhookPayload;
  try {
    payload = (typeof event.body === "string" ? JSON.parse(event.body) : event.body) as ShopifyWebhookPayload;
  } catch (err) {
    console.error("[processWebhook] ❌ STEP 2 (PARSE_BODY) failed:", err);
    log.error({ step: "PARSE_BODY", err }, "Invalid JSON body");
    throw err;
  }

  const bulkOperationGid = payload?.admin_graphql_api_id;
  const bulkType = payload?.type;
  const bulkStatus = payload?.status;
  console.log("[processWebhook] 2. body parsed →", { bulkOperationGid, bulkType, bulkStatus });

  log.info(
    { step: "WEBHOOK_RECEIVED", topic, bulkOperationGid, bulkStatus, bulkType, shopDomain },
    "Webhook received",
  );

  // ── Gate: only mutation type ──
  if (bulkType !== "mutation") {
    console.log("[processWebhook] ⏭  SKIP — not a mutation bulk operation (type:", bulkType, ")");
    log.info({ step: "SKIP_NON_MUTATION", bulkType }, "Skipping — not a mutation bulk operation");
    return;
  }

  if (!bulkOperationGid || !shopDomain) {
    console.log("[processWebhook] ⏭  SKIP — missing bulkOperationGid or shopDomain");
    log.warn({ step: "MISSING_FIELDS", bulkOperationGid, shopDomain }, "Missing bulkOperationId or shopDomain");
    return;
  }

  // ── Find migration ──
  let migration: Migration | null;
  try {
    console.log("[processWebhook] 3. finding migration →", { bulkOperationGid, shopDomain });
    migration = await repo.findMigrationByBulkOpId(bulkOperationGid, shopDomain);
  } catch (err) {
    console.error("[processWebhook] ❌ STEP 3 (FIND_MIGRATION) failed:", err);
    log.error({ step: "FIND_MIGRATION", bulkOperationGid, shopDomain, err }, "DB error while fetching migration");
    throw err;
  }
  if (!migration) {
    console.log("[processWebhook] ⏭  SKIP — migration not found");
    log.warn({ step: "MIGRATION_NOT_FOUND", bulkOperationGid, shopDomain }, "Migration not found — skipping");
    return;
  }
  console.log("[processWebhook] 3. migration matched →", {
    migrationId: migration.migrationId,
    status: migration.status,
    platformKey: migration.platformKey,
  });

  log.info(
    {
      step: "MIGRATION_MATCHED",
      migrationId: migration.migrationId,
      status: migration.status,
      platformKey: migration.platformKey,
    },
    "Migration matched",
  );

  // ── Bulk-level failure path ──
  if (bulkStatus === "failed") {
    const failStatus = String(migration.status || "").startsWith("rollback_")
      ? "rollback_failed"
      : "bulk_failed";
    console.log("[processWebhook] ⚠  bulk operation FAILED on Shopify → setting status:", failStatus);
    try {
      await repo.updateMigrationStatus(migration.migrationId, failStatus);
    } catch (err) {
      console.error("[processWebhook] ❌ UPDATE_STATUS_ON_FAILURE failed:", err);
      log.error(
        { step: "UPDATE_STATUS_ON_FAILURE", migrationId: migration.migrationId, err },
        "updateMigrationStatus on bulk failure failed",
      );
    }
    log.warn(
      {
        step: "BULK_FAILED_ON_SHOPIFY",
        shopDomain,
        errorCode: payload?.error_code,
        bulkOperationGid,
        finalStatus: failStatus,
      },
      "Bulk operation failed on Shopify side",
    );
    return;
  }

  if (bulkStatus !== "completed") {
    console.log("[processWebhook] ⏭  SKIP — status not 'completed' (is:", bulkStatus, ")");
    log.info({ step: "SKIP_NON_COMPLETED", bulkStatus }, "Skipping — status not completed");
    return;
  }

  // ── Access token ──
  let accessToken: string | null;
  try {
    console.log("[processWebhook] 4. fetching access token for", shopDomain);
    accessToken = await repo.getAccessToken(shopDomain);
  } catch (err) {
    console.error("[processWebhook] ❌ STEP 4 (GET_ACCESS_TOKEN) failed:", err);
    log.error({ step: "GET_ACCESS_TOKEN", shopDomain, err }, "DB error while fetching access token");
    throw err;
  }
  if (!accessToken) {
    console.log("[processWebhook] ⏭  SKIP — no access token (shop session not found)");
    log.warn({ step: "NO_ACCESS_TOKEN", shopDomain }, "Shop session not found");
    return;
  }

  // ── Bulk operation details from Shopify ──
  let bulkOperation: BulkOperationNode | null;
  try {
    console.log("[processWebhook] 5. fetching bulk operation details from Shopify…");
    bulkOperation = await fetchBulkOperationDetails(shopDomain, accessToken, bulkOperationGid);
  } catch (err) {
    console.error("[processWebhook] ❌ STEP 5 (FETCH_BULK_OP) failed:", err);
    log.error({ step: "FETCH_BULK_OP", shopDomain, bulkOperationGid, err }, "Failed to fetch bulk operation details");
    throw err;
  }
  console.log("[processWebhook] 5. bulk operation →", {
    url: bulkOperation?.url,
    objectCount: bulkOperation?.objectCount,
  });
  log.info(
    {
      step: "BULK_OP_FETCHED",
      shopDomain,
      url: bulkOperation?.url,
      objectCount: bulkOperation?.objectCount,
    },
    "Bulk operation details fetched",
  );
  if (!bulkOperation?.url) {
    console.log("[processWebhook] ⏭  SKIP — no result URL, nothing to process");
    log.warn({ step: "EMPTY_RESULT_URL", bulkOperationGid }, "No result URL — nothing to process");
    return;
  }

  // ── Download + parse JSONL ──
  let lines: JSONLLine[];
  try {
    console.log("[processWebhook] 6. downloading + parsing JSONL…");
    lines = await downloadAndParseJSONL(bulkOperation.url);
  } catch (err) {
    console.error("[processWebhook] ❌ STEP 6 (DOWNLOAD_JSONL) failed:", err);
    log.error({ step: "DOWNLOAD_JSONL", shopDomain, err }, "Failed to download/parse JSONL result");
    throw err;
  }
  console.log("[processWebhook] 6. JSONL parsed →", lines.length, "lines");
  log.info({ step: "JSONL_DOWNLOADED", shopDomain, lineCount: lines.length }, "JSONL downloaded");

  // ── Phase detection ──
  const phase = detectPhase(migration.status);
  if (!phase) {
    console.log("[processWebhook] ⏭  SKIP — unknown phase for status:", migration.status);
    log.warn(
      { step: "UNKNOWN_PHASE", migrationId: migration.migrationId, status: migration.status },
      "Unknown migration.status — cannot detect phase",
    );
    return;
  }
  console.log("[processWebhook] 7. phase detected →", phase);

  log.info({ step: "PHASE_DETECTED", migrationId: migration.migrationId, phase }, "Phase detected");

  // ── Dispatch to phase handler ──
  try {
    console.log(`[processWebhook] 8. dispatching to "${phase}" handler…`);
    let result: PhaseResult;
    switch (phase) {
      case "create":
        result = await handleCreatePhase({ repo, migration, lines });
        break;
      case "rollback_cancel":
        result = await handleRollbackCancelPhase({ repo, migration, lines, shopDomain });
        break;
      case "rollback_revoke":
        result = await handleRollbackRevokePhase({ repo, migration, lines });
        break;
      default:
        console.log("[processWebhook] ⏭  SKIP — unhandled phase:", phase);
        log.warn({ step: "UNHANDLED_PHASE", phase }, "Unhandled phase");
        return;
    }
    console.log("[processWebhook] ✅ PHASE COMPLETED →", result);
    console.log("[processWebhook] ━━━━━━━━━ DONE ━━━━━━━━━\n");
    log.info(
      { step: "PHASE_COMPLETED", migrationId: migration.migrationId, ...result, phase },
      "Phase completed",
    );
  } catch (err) {
    console.error(`[processWebhook] ❌ STEP 8 — "${phase}" phase handler FAILED:`, err);
    log.error(
      { step: "PHASE_HANDLER_FAILED", phase, migrationId: migration.migrationId, err },
      "Phase handler failed",
    );
    if (phase.startsWith("rollback_")) {
      try {
        await repo.updateMigrationStatus(migration.migrationId, "rollback_failed");
      } catch (dbErr) {
        console.error("[processWebhook] ❌ UPDATE_STATUS_ON_PHASE_CRASH failed:", dbErr);
        log.error(
          { step: "UPDATE_STATUS_ON_PHASE_CRASH", migrationId: migration.migrationId, err: dbErr },
          "updateMigrationStatus on phase crash failed",
        );
      }
    }
    throw err;
  }
}
