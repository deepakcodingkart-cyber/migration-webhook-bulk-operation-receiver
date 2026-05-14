import { logger } from "../logger.ts";
import { GET_BULK_OPERATION_QUERY } from "../graphql/queries.ts";
import type {
  BulkOperationNode,
  CancelEligibleRow,
  CancelResults,
  CancelUpdate,
  CreateResultItem,
  CreateResults,
  JSONLLine,
  RevokeResults,
  RevokeUpdate,
} from "../types/index.ts";

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

// ────────────────────────────────────────────────────────────────
// Shopify GraphQL — generic
// ────────────────────────────────────────────────────────────────
export async function shopifyGraphQL<T = unknown>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Shopify API HTTP error: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as { data: T; errors?: unknown };

  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

export async function fetchBulkOperationDetails(
  shopDomain: string,
  accessToken: string,
  bulkOperationGid: string,
): Promise<BulkOperationNode | null> {
  try {
    const data = await shopifyGraphQL<{ node: BulkOperationNode | null }>(
      shopDomain,
      accessToken,
      GET_BULK_OPERATION_QUERY,
      { id: bulkOperationGid }
    );
    return data?.node || null;
  } catch (err) {
    logger.error("fetchBulkOperationDetails failed", { shopDomain, bulkOperationGid }, err);
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────
// JSONL download + parse
// ────────────────────────────────────────────────────────────────
export async function downloadAndParseJSONL(url: string): Promise<JSONLLine[]> {
  if (!url) {
    logger.warn("downloadAndParseJSONL", { message: "No URL provided" });
    return [];
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download JSONL: HTTP ${response.status}`);
  }

  const text   = await response.text();
  const lines  = text.trim().split("\n").filter(Boolean);
  const parsed: JSONLLine[] = [];

  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      logger.warn("JSONL parse error on line", { line });
    }
  }

  return parsed;
}

// ────────────────────────────────────────────────────────────────
// CREATE phase — process subscriptionContractAtomicCreate JSONL
// ────────────────────────────────────────────────────────────────
export function processJSONLResults(lines: JSONLLine[]): CreateResults {
  const successes: CreateResultItem[] = [];
  const failures:  CreateResultItem[] = [];

  for (const line of lines) {
    const result = line?.data?.subscriptionContractAtomicCreate;

    if (!result) {
      logger.warn("processJSONLResults: unexpected line format", { line });
      continue;
    }

    const { contract, userErrors } = result;
    const lineNumber = line.__lineNumber;

    if (userErrors && userErrors.length > 0) {
      const errorMessage = userErrors.map((e) => e.message).join(", ");
      failures.push({
        lineNumber,
        shopifySubscriptionId: null,
        errorMessage,
      });
      logger.warn("processJSONLResults: failure", { lineNumber, errorMessage });
    } else if (contract?.id) {
      successes.push({
        lineNumber,
        shopifySubscriptionId: contract.id,
        errorMessage: null,
      });
      logger.info("processJSONLResults: success", {
        lineNumber, shopifySubscriptionId: contract.id,
      });
    } else {
      failures.push({
        lineNumber,
        shopifySubscriptionId: null,
        errorMessage: "Unknown error — no contract ID and no userErrors",
      });
      logger.warn("processJSONLResults: unknown case", { lineNumber });
    }
  }

  logger.info("processJSONLResults done", {
    total:     lines.length,
    successes: successes.length,
    failures:  failures.length,
  });

  return { successes, failures };
}

// ────────────────────────────────────────────────────────────────
// ROLLBACK CANCEL phase — process subscriptionContractCancel JSONL
// successAfterStatus: "rollback_cancelled" (other_platform — revoke pending)
//                     OR "deleted" (other platforms — final)
// ────────────────────────────────────────────────────────────────
export function processCancelJSONLResults(
  lines: JSONLLine[],
  eligible: CancelEligibleRow[],
  successAfterStatus: string,
): CancelResults {
  const updates: CancelUpdate[] = [];

  for (const line of lines) {
    const result     = line?.data?.subscriptionContractCancel;
    const lineNumber = line.__lineNumber;
    const sub        = eligible[lineNumber];

    if (!sub) {
      logger.warn("processCancelJSONLResults: no sub at lineNumber", { lineNumber });
      continue;
    }

    if (!result) {
      logger.warn("processCancelJSONLResults: unexpected line format", { line });
      continue;
    }

    const { contract, userErrors } = result;

    if (contract?.id && (!userErrors || userErrors.length === 0)) {
      // ── OK ──
      updates.push({
        lineNumber,
        migrationStatus: successAfterStatus,
        errorCode:       null,
        errorMessage:    null,
        errorDetails:    null,
        outcome:         "success",
      });
    } else {
      // ── Error (contract may be null) ──
      const errorMessage = userErrors?.[0]?.message || "Cancel failed (unknown error)";
      updates.push({
        lineNumber,
        migrationStatus: "creation_failed",
        errorCode:       "ROLLBACK_CANCEL_FAILED",
        errorMessage,
        errorDetails:    { userErrors: userErrors || [], contractId: sub.shopifySubscriptionId },
        outcome:         "failure",
      });
    }
  }

  const successes = updates.filter((u) => u.outcome === "success");
  const failures  = updates.filter((u) => u.outcome === "failure");

  logger.info("processCancelJSONLResults done", {
    total:     lines.length,
    successes: successes.length,
    failures:  failures.length,
  });

  return { updates, successes, failures };
}

// ────────────────────────────────────────────────────────────────
// ROLLBACK REVOKE phase — process customerPaymentMethodRevoke JSONL
// successStatus: "deleted" — paymentId revoke ok → all sharing subs become deleted
// failureStatus: null      — keep migrationStatus = "rollback_cancelled" (COALESCE in DB)
// ────────────────────────────────────────────────────────────────
export function processRevokeJSONLResults(
  lines: JSONLLine[],
  paymentIds: string[],
): RevokeResults {
  const updates: RevokeUpdate[] = [];

  for (const line of lines) {
    const result     = line?.data?.customerPaymentMethodRevoke;
    const lineNumber = line.__lineNumber;
    const paymentId  = paymentIds[lineNumber];

    if (!paymentId) {
      logger.warn("processRevokeJSONLResults: no paymentId at lineNumber", { lineNumber });
      continue;
    }

    if (!result) {
      logger.warn("processRevokeJSONLResults: unexpected line format", { line });
      continue;
    }

    const { revokedCustomerPaymentMethodId, userErrors } = result;

    if (revokedCustomerPaymentMethodId && (!userErrors || userErrors.length === 0)) {
      // ── OK ──
      updates.push({
        paymentMethodId: paymentId,
        migrationStatus: "deleted",
        errorCode:       null,
        errorMessage:    null,
        errorDetails:    null,
        outcome:         "success",
      });
    } else {
      // ── Error — keep "rollback_cancelled", attach revoke error fields ──
      const errorMessage = userErrors?.[0]?.message || "Revoke failed (unknown error)";
      updates.push({
        paymentMethodId: paymentId,
        migrationStatus: null,  // ← null = keep current ("rollback_cancelled" via COALESCE)
        errorCode:       "ROLLBACK_REVOKE_FAILED",
        errorMessage,
        errorDetails:    { userErrors: userErrors || [], paymentMethodId: paymentId },
        outcome:         "failure",
      });
    }
  }

  const successes = updates.filter((u) => u.outcome === "success");
  const failures  = updates.filter((u) => u.outcome === "failure");

  logger.info("processRevokeJSONLResults done", {
    total:     lines.length,
    successes: successes.length,
    failures:  failures.length,
  });

  return { updates, successes, failures };
}
