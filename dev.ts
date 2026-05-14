/**
 * ─────────────────────────────────────────────────────────────
 * LOCAL DEV INVOKER — NOT deployed to AWS Lambda.
 * ─────────────────────────────────────────────────────────────
 * The AWS Lambda runtime injects an `awslambda` global (used by
 * index.ts for response streaming). Locally that global does not
 * exist, so this file:
 *   1. Polyfills `awslambda` BEFORE index.ts is loaded.
 *   2. Builds a sample Shopify `bulk_operations/finish` webhook event.
 *   3. Calls the exported `handler` and prints what it streamed back.
 *
 * Delete this file (and the `start` script in package.json) once you
 * move to a real Lambda deployment.
 */
import "dotenv/config";
import { Writable } from "node:stream";
import type { LambdaContext, LambdaEvent } from "./types/index.ts";

// ── Mock response stream — mirrors awslambda.ResponseStream ──────
class MockResponseStream extends Writable {
  private readonly chunks: Buffer[] = [];

  setContentType(contentType: string): void {
    console.log(`[responseStream] content-type: ${contentType}`);
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  /** Everything written before .end() was called. */
  get body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

// ── Polyfill the `awslambda` streaming global BEFORE index.ts loads ──
// index.ts calls awslambda.streamifyResponse() at module-load time, so
// this assignment must happen before the dynamic import() below.
(globalThis as unknown as { awslambda: unknown }).awslambda = {
  streamifyResponse: <T>(handler: T): T => handler,
};

// ── Sample Shopify bulk_operations/finish webhook event ─────────
// Override the shop / bulk-operation GID via .env for real data.
const sampleEvent: LambdaEvent = {
  headers: {
    "x-shopify-topic": "bulk_operations/finish",
    "x-shopify-shop-domain": process.env.DEV_SHOP_DOMAIN || "checkout-ui-build.myshopify.com",
  },
  body: JSON.stringify({
    admin_graphql_api_id:
      process.env.DEV_BULK_OP_GID || "gid://shopify/BulkOperation/7425751843090",
    type: "mutation",
    status: "completed",
  }),
  isBase64Encoded: false,
};

const sampleContext: LambdaContext = {
  functionName: "local-dev",
  functionVersion: "$LATEST",
  awsRequestId: `local-${Date.now()}`,
  invokedFunctionArn: "arn:aws:lambda:local:000000000000:function:local-dev",
  memoryLimitInMB: "128",
};

async function main(): Promise<void> {
  // Dynamic import — MUST run after the awslambda polyfill above.
  const { handler } = await import("./index.ts");
  const responseStream = new MockResponseStream();

  console.log("▶  invoking handler locally…");
  await handler(sampleEvent, responseStream, sampleContext);
  console.log("◀  handler returned. responseStream body:", responseStream.body);
}

main().catch((err) => {
  console.error("local dev invoke failed:", err);
  process.exit(1);
});
