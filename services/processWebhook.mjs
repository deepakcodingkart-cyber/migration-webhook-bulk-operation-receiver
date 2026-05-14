import {
  fetchBulkOperationDetails,
  downloadAndParseJSONL,
} from "./shopify.mjs";
import {
  handleCreatePhase,
  handleRollbackCancelPhase,
  handleRollbackRevokePhase,
} from "./handler.mjs";
import { detectPhase } from "../utils/helper.mjs";
import { getHeader } from "../utils/webhook.mjs";

// ─────────────────────────────────────────────────────────────
// Background work — every external/db call is wrapped so we can
// log + tag the failing step before bubbling up.
// ─────────────────────────────────────────────────────────────
export async function processWebhook({ repo, event, log }) {
  console.log("repo", repo)
  console.log("event", event)
  console.log("log", log)
  // ── Headers (real Shopify webhook delivers shop + topic via headers) ──
  const topic = getHeader(event.headers, "x-shopify-topic") || "";
  const shopDomain = getHeader(event.headers, "x-shopify-shop-domain") || "";

  // ── Parse body ──
  let payload;
  try {
    payload = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch (err) {
    log.error({ step: "PARSE_BODY", err }, "Invalid JSON body");
    throw err;
  }

  const bulkOperationGid = payload?.admin_graphql_api_id;
  const bulkType = payload?.type;
  const bulkStatus = payload?.status;

  log.info(
    { step: "WEBHOOK_RECEIVED", topic, bulkOperationGid, bulkStatus, bulkType, shopDomain },
    "Webhook received",
  );

  // ── Gate: only mutation type ──
  if (bulkType !== "mutation") {
    log.info({ step: "SKIP_NON_MUTATION", bulkType }, "Skipping — not a mutation bulk operation");
    return;
  }

  if (!bulkOperationGid || !shopDomain) {
    log.warn({ step: "MISSING_FIELDS", bulkOperationGid, shopDomain }, "Missing bulkOperationId or shopDomain");
    return;
  }

  // ── Find migration ──
  let migration;
  try {

    console.log("findMigrationByBulkOpId: ", bulkOperationGid, shopDomain)
    migration = await repo.findMigrationByBulkOpId(bulkOperationGid, shopDomain);
    console.log("migration: ", migration)
  } catch (err) {
    log.error({ step: "FIND_MIGRATION", bulkOperationGid, shopDomain, err }, "DB error while fetching migration");
    throw err;
  }
  if (!migration) {
    log.warn({ step: "MIGRATION_NOT_FOUND", bulkOperationGid, shopDomain }, "Migration not found — skipping");
    return;
  }

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
    try {
      await repo.updateMigrationStatus(migration.migrationId, failStatus);
    } catch (err) {
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
    log.info({ step: "SKIP_NON_COMPLETED", bulkStatus }, "Skipping — status not completed");
    return;
  }

  // ── Access token ──
  let accessToken;
  try {
    accessToken = await repo.getAccessToken(shopDomain);
  } catch (err) {
    log.error({ step: "GET_ACCESS_TOKEN", shopDomain, err }, "DB error while fetching access token");
    throw err;
  }
  if (!accessToken) {
    log.warn({ step: "NO_ACCESS_TOKEN", shopDomain }, "Shop session not found");
    return;
  }

  // ── Bulk operation details from Shopify ──
  let bulkOperation;
  try {
    bulkOperation = await fetchBulkOperationDetails(shopDomain, accessToken, bulkOperationGid);
  } catch (err) {
    log.error({ step: "FETCH_BULK_OP", shopDomain, bulkOperationGid, err }, "Failed to fetch bulk operation details");
    throw err;
  }
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
    log.warn({ step: "EMPTY_RESULT_URL", bulkOperationGid }, "No result URL — nothing to process");
    return;
  }

  // ── Download + parse JSONL ──
  let lines;
  try {
    lines = await downloadAndParseJSONL(bulkOperation.url);
  } catch (err) {
    log.error({ step: "DOWNLOAD_JSONL", shopDomain, err }, "Failed to download/parse JSONL result");
    throw err;
  }
  log.info({ step: "JSONL_DOWNLOADED", shopDomain, lineCount: lines.length }, "JSONL downloaded");

  // ── Phase detection ──
  const phase = detectPhase(migration.status);
  if (!phase) {
    log.warn(
      { step: "UNKNOWN_PHASE", migrationId: migration.migrationId, status: migration.status },
      "Unknown migration.status — cannot detect phase",
    );
    return;
  }

  log.info({ step: "PHASE_DETECTED", migrationId: migration.migrationId, phase }, "Phase detected");

  // ── Dispatch to phase handler ──
  try {
    let result;
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
        log.warn({ step: "UNHANDLED_PHASE", phase }, "Unhandled phase");
        return;
    }
    log.info(
      { step: "PHASE_COMPLETED", migrationId: migration.migrationId, phase, ...result },
      "Phase completed",
    );
  } catch (err) {
    log.error(
      { step: "PHASE_HANDLER_FAILED", phase, migrationId: migration.migrationId, err },
      "Phase handler failed",
    );
    if (phase.startsWith("rollback_")) {
      try {
        await repo.updateMigrationStatus(migration.migrationId, "rollback_failed");
      } catch (dbErr) {
        log.error(
          { step: "UPDATE_STATUS_ON_PHASE_CRASH", migrationId: migration.migrationId, err: dbErr },
          "updateMigrationStatus on phase crash failed",
        );
      }
    }
    throw err;
  }
}
