import "dotenv/config";
import { logger } from "./logger.mjs";
import { getDbPool } from "./config/db.mjs";
import { Repository } from "./config/repository.mjs";
import {
  calculateDuration,
  getHeader,
  verifyShopifyWebhook,
} from "./utils/webhook.mjs";
import { statusCodes } from "./utils/constant.mjs";
import { initSentry, sendSentryError } from "./utils/sentry.mjs";
import { processWebhook } from "./services/processWebhook.mjs";

// ─────────────────────────────────────────────────────────────
// Singletons — reused across Lambda invocations
// ─────────────────────────────────────────────────────────────
initSentry();
const db = getDbPool();
const repo = new Repository(db);

/**
 * Shopify Webhook Lambda — bulk_operations/finish
 *
 * Shopify expects an ACK within 5 seconds or it retries the webhook.
 * We use awslambda.streamifyResponse to:
 *   1. Verify HMAC
 *   2. Send "200 success" back to Shopify immediately
 *   3. Continue heavy work (DB, Shopify GraphQL, JSONL download) in background
 *
 * Any error after the ACK is logged but does NOT trigger a Shopify retry.
 */
export const handler = awslambda.streamifyResponse(
  async (event, responseStream, _context) => {
    logger.setLambdaContext(_context);

    const shop         = getHeader(event.headers, "x-shopify-shop-domain");
    const webhookTopic = getHeader(event.headers, "x-shopify-topic");
    const lambdaName   = process.env.AWS_LAMBDA_FUNCTION_NAME || "local-dev";
    const awsRegion    = process.env.AWS_REGION || "local";
    const lambdaUrl    = `https://${lambdaName}.lambda-url.${awsRegion}.aws/webhook/${webhookTopic}`;

    const startTime    = Date.now();

    const log = logger.child({
      shop,
      url: lambdaUrl,
      method: "webhook",
      route:  `/webhook/${webhookTopic}`,
      lambdaName,
    });

    // ── 1. HMAC validation (currently disabled — uncomment when SHOPIFY_WEBHOOK_SECRET is set) ──
    // const isValid = verifyShopifyWebhook(event);
    // if (!isValid) {
    //   log.error(
    //     {
            // service: lambdaName,
            // module: "handler",
            // step: "HMAC_VALIDATION",
            // statusCode: statusCodes.UNAUTHORIZED
        // },
    //     "❌ HMAC validation failed for incoming Shopify webhook",
    //   );
    //   responseStream.setContentType("application/json");
    //   responseStream.write(JSON.stringify({ message: "Invalid webhook" }));
    //   responseStream.end();
    //   return;
    // }
    //
    // log.info(
    //   {
    //    service: lambdaName,
    //    module: "handler",
    //    step: "HMAC_VALIDATION",
    //    statusCode: statusCodes.OK },
    //   "HMAC validation passed",
    // );

    // ── 2. Immediate ACK to Shopify (must happen <5s) ──
    responseStream.setContentType("application/json");
    responseStream.write(JSON.stringify({ message: "success" }));
    responseStream.end();

    // ── 3. Background processing — failure here does NOT impact webhook ACK ──
    try {
      await processWebhook({ repo, event, log });

      log.info(
        {
          service: lambdaName,
          module: "handler",
          step:       "WEBHOOK_PROCESSED",
          duration:   calculateDuration(startTime),
          statusCode: statusCodes.OK,
        },
        "✅ Webhook processing completed successfully",
      );
    } catch (error) {
      log.error(
        {
          service: lambdaName,
          module: "handler",
          step:       "WEBHOOK_FAILED",
          duration:   calculateDuration(startTime),
          statusCode: statusCodes.SERVER_ERROR,
          err:        error,
        },
        "❌ Error during webhook processing",
      );
      await sendSentryError(error);
    }
  },
);
