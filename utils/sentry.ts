import * as Sentry from "@sentry/aws-serverless";

export const initSentry = (): void => {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.APP_VERSION,
    serverName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    tracesSampleRate: 1.0,
    beforeSend(event) {
      event.tags = {
        ...event.tags,
        function_name: process.env.AWS_LAMBDA_FUNCTION_NAME,
        function_version: process.env.AWS_LAMBDA_FUNCTION_VERSION,
        aws_region: process.env.AWS_REGION,
      };
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
      }
      return event;
    },
  });
};

/**
 * Capture a thrown Error object with context
 * @param {Error} error
 */
export const sendSentryError = async (error: unknown): Promise<void> => {
  Sentry.withScope((scope) => {
    scope.setTag("function_name", process.env.AWS_LAMBDA_FUNCTION_NAME);
    scope.setTag("aws_region", process.env.AWS_REGION);
    scope.setTag("function_version", process.env.AWS_LAMBDA_FUNCTION_VERSION);
    scope.setTransactionName(process.env.AWS_LAMBDA_FUNCTION_NAME);
    Sentry.captureException(error);
  });
  await Sentry.flush(2000);
};
