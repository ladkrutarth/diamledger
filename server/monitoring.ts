type SentryNode = typeof import('@sentry/node');

let sentry: SentryNode | undefined;
let starting: Promise<void> | undefined;

export function initMonitoring(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return Promise.resolve();
  starting ??= import('@sentry/node')
    .then((module) => {
      module.init({
        dsn,
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
        release: process.env.VERCEL_GIT_COMMIT_SHA,
        // Request bodies carry passwords and SMTP credentials.
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
        },
        tracesSampleRate: 0,
      });
      sentry = module;
    })
    .catch((error) => {
      console.error('Sentry failed to start:', error);
    });
  return starting;
}

export type ErrorContext = {
  method?: string;
  path?: string;
  userId?: string;
  organizationId?: string;
};

export async function reportError(error: unknown, context: ErrorContext = {}): Promise<void> {
  if (!sentry) return;
  sentry.withScope((scope) => {
    if (context.userId) scope.setUser({ id: context.userId });
    if (context.organizationId) scope.setTag('organization_id', context.organizationId);
    if (context.method) scope.setTag('http.method', context.method);
    if (context.path) scope.setTag('http.path', context.path);
    sentry!.captureException(error);
  });
  // Serverless functions can be frozen as soon as the response ends.
  if (process.env.VERCEL === '1') await flushMonitoring();
}

export async function flushMonitoring(): Promise<void> {
  await sentry?.flush(2000);
}
