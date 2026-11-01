type SentryReact = typeof import('@sentry/react');

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

let sentry: Promise<SentryReact | undefined> | undefined;

function loadSentry(): Promise<SentryReact | undefined> {
  if (!dsn) return Promise.resolve(undefined);
  sentry ??= import('@sentry/react')
    .then((module) => {
      module.init({
        dsn,
        environment: import.meta.env.MODE,
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
        },
      });
      return module;
    })
    .catch((error) => {
      console.error('Sentry failed to load:', error);
      return undefined;
    });
  return sentry;
}

export function initMonitoring(): void {
  void loadSentry();
}

export function reportError(error: unknown, componentStack?: string): void {
  if (!dsn) return;
  void loadSentry().then((module) => {
    module?.captureException(error, componentStack ? { contexts: { react: { componentStack } } } : undefined);
  });
}
