// Ambient declaration for the `awslambda` global injected by the AWS Lambda
// Node.js runtime when response streaming is enabled. The runtime provides the
// implementation — we only declare the shape used by this project.

import type { Writable } from "node:stream";
import type { LambdaContext, LambdaEvent } from "./index.ts";

declare global {
  namespace awslambda {
    interface ResponseStream extends Writable {
      setContentType(contentType: string): void;
    }

    type StreamifyHandler<TEvent = LambdaEvent> = (
      event: TEvent,
      responseStream: ResponseStream,
      context: LambdaContext,
    ) => Promise<void>;

    function streamifyResponse<TEvent = LambdaEvent>(
      handler: StreamifyHandler<TEvent>,
    ): StreamifyHandler<TEvent>;
  }
}

export {};
