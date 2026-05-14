// ────────────────────────────────────────────────────────────────
// Shared types — used across the Lambda.
// ────────────────────────────────────────────────────────────────

// ── AWS Lambda ──────────────────────────────────────────────────

/** Subset of the AWS Lambda context object actually consumed here. */
export interface LambdaContext {
  functionName: string;
  functionVersion: string;
  awsRequestId: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  [key: string]: unknown;
}

/** Incoming Lambda URL / API Gateway style event. */
export interface LambdaEvent {
  headers?: Record<string, string | undefined>;
  body?: string | Record<string, unknown> | null;
  isBase64Encoded?: boolean;
  [key: string]: unknown;
}

// ── Logger ──────────────────────────────────────────────────────

export type LogPayload = Record<string, unknown>;

/** The wrapped pino logger surface (see logger.ts). */
export interface Logger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  child(bindings: LogPayload): Logger;
}

// ── Domain ──────────────────────────────────────────────────────

/** Migration primary key — DB column may be uuid (string) or int. */
export type MigrationId = string | number;

/** Phase resolved from `migration.status` (see utils/helper.ts). */
export type Phase = "create" | "rollback_cancel" | "rollback_revoke";

/** A row from the "Migrations" table (findMigrationByBulkOpId uses SELECT *). */
export interface Migration {
  migrationId: MigrationId;
  shopId: string;
  status: string;
  platformKey: string;
  bulkOperationId: string | null;
  rollbackCancelBulkOpId: string | null;
  rollbackRevokeBulkOpId: string | null;
  createdRows: number;
  failedRows: number;
}

/** A row returned by Repository.getCancelEligible. */
export interface CancelEligibleRow {
  id: MigrationId;
  shopifySubscriptionId: string | null;
  shopifyPaymentMethodId: string | null;
  migrationStatus: string;
  jsonlLineNumber: number | null;
}

/** A row returned by Repository.getRevokeMap (before dedup). */
export interface RevokeMapRow {
  id: MigrationId;
  shopifyPaymentMethodId: string;
  jsonlLineNumber: number;
}

/** Deduped revoke lookup produced by Repository.getRevokeMap. */
export interface RevokeMap {
  paymentIds: string[];
  subsByPaymentId: Map<string, MigrationId[]>;
}

// ── Shopify ─────────────────────────────────────────────────────

export interface ShopifyUserError {
  field?: string[] | null;
  message: string;
}

/** Node returned by GET_BULK_OPERATION_QUERY. */
export interface BulkOperationNode {
  id: string;
  status: string;
  errorCode: string | null;
  type: string;
  url: string | null;
  objectCount: string;
  fileSize: string | null;
  partialDataUrl: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Shopify webhook request body for bulk_operations/finish. */
export interface ShopifyWebhookPayload {
  admin_graphql_api_id?: string;
  type?: string;
  status?: string;
  error_code?: string;
  [key: string]: unknown;
}

/** A single parsed line of a bulk-operation JSONL result file. */
export interface JSONLLine {
  __lineNumber: number;
  data?: {
    subscriptionContractAtomicCreate?: {
      contract?: { id?: string } | null;
      userErrors?: ShopifyUserError[];
    };
    subscriptionContractCancel?: {
      contract?: { id?: string } | null;
      userErrors?: ShopifyUserError[];
    };
    customerPaymentMethodRevoke?: {
      revokedCustomerPaymentMethodId?: string | null;
      userErrors?: ShopifyUserError[];
    };
  };
  [key: string]: unknown;
}

// ── Phase processing — results & update shapes ──────────────────

export type Outcome = "success" | "failure";

/** CREATE phase — one parsed JSONL outcome. */
export interface CreateResultItem {
  lineNumber: number;
  shopifySubscriptionId: string | null;
  errorMessage: string | null;
}

export interface CreateResults {
  successes: CreateResultItem[];
  failures: CreateResultItem[];
}

/** CREATE phase — one DB update row (by jsonlLineNumber). */
export interface CreateUpdate {
  lineNumber: number;
  migrationStatus: string;
  shopifySubscriptionId: string | null;
  errorMessage: string | null;
}

/** ROLLBACK CANCEL phase — one DB update row (by jsonlLineNumber). */
export interface CancelUpdate {
  lineNumber: number;
  migrationStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
  outcome: Outcome;
}

export interface CancelResults {
  updates: CancelUpdate[];
  successes: CancelUpdate[];
  failures: CancelUpdate[];
}

/** ROLLBACK REVOKE phase — one DB update row (by shopifyPaymentMethodId). */
export interface RevokeUpdate {
  paymentMethodId: string;
  migrationStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
  outcome: Outcome;
}

export interface RevokeResults {
  updates: RevokeUpdate[];
  successes: RevokeUpdate[];
  failures: RevokeUpdate[];
}

/** Value returned by every phase handler in services/handler.ts. */
export interface PhaseResult {
  phase: Phase;
  successes: number;
  failures: number;
  finalStatus?: string | null;
  next?: string;
  error?: string;
}
