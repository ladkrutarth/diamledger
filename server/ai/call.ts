import type { DbPool } from '../db.js';
import { reportError } from '../monitoring.js';
import { AiUnavailableError } from './client.js';

export type TokenUsage = { inputTokens?: number; outputTokens?: number };

export type ModelCallContext = {
  feature: 'manifest_parser' | 'payment_reminder' | 'assistant' | 'month_review';
  promptVersion: string;
  model: string;
  organizationId: string;
  userId: string;
};

export type ModelRun<T> = (signal: AbortSignal) => Promise<{ value: T; usage?: TokenUsage }>;

type Outcome = 'ok' | 'error' | 'timeout' | 'blocked';

export function aiEnabled(): boolean {
  return process.env.AI_ENABLED !== 'false';
}

function dailyTokenBudget(): number {
  const configured = Number(process.env.AI_DAILY_TOKEN_BUDGET);
  return Number.isFinite(configured) && configured > 0 ? configured : 2_000_000;
}

function timeoutMs(): number {
  const configured = Number(process.env.AI_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 20_000;
}

export function usageFrom(metadata: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined): TokenUsage {
  return { inputTokens: metadata?.promptTokenCount, outputTokens: metadata?.candidatesTokenCount };
}

export async function tokensUsedToday(pool: DbPool, organizationId: string): Promise<number> {
  const result = await pool.query<{ used: string }>(
    `SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS used
     FROM ai_calls WHERE organization_id = $1 AND created_at >= date_trunc('day', now())`,
    [organizationId],
  );
  return Number(result.rows[0].used);
}

async function record(
  pool: DbPool,
  context: ModelCallContext,
  outcome: Outcome,
  latencyMs: number,
  usage: TokenUsage = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO ai_calls
       (organization_id, user_id, feature, model, prompt_version, outcome, latency_ms, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [context.organizationId, context.userId, context.feature, context.model, context.promptVersion, outcome,
      Math.round(latencyMs), usage.inputTokens ?? null, usage.outputTokens ?? null],
  ).catch((error) => console.error('Could not record AI call:', (error as Error).message));
}

function retryable(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' && (status === 429 || status >= 500);
}

async function attempt<T>(run: ModelRun<T>): Promise<{ value: T; usage?: TokenUsage }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AiUnavailableError('timeout', 'The AI service took too long to answer. Try again.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function callModel<T>(pool: DbPool, context: ModelCallContext, run: ModelRun<T>): Promise<T> {
  if (!aiEnabled()) {
    await record(pool, context, 'blocked', 0);
    throw new AiUnavailableError('disabled', 'AI features are turned off on this server.');
  }
  if ((await tokensUsedToday(pool, context.organizationId)) >= dailyTokenBudget()) {
    await record(pool, context, 'blocked', 0);
    throw new AiUnavailableError('budget', "Your company has used today's AI allowance. It resets at midnight.");
  }

  const started = Date.now();
  let lastError: unknown;
  for (let tries = 1; tries <= 2; tries += 1) {
    try {
      const { value, usage } = await attempt(run);
      await record(pool, context, 'ok', Date.now() - started, usage);
      return value;
    } catch (error) {
      lastError = error;
      if (tries === 1 && retryable(error)) continue;
      break;
    }
  }

  const outcome: Outcome =
    lastError instanceof AiUnavailableError ? (lastError.reason === 'timeout' ? 'timeout' : 'blocked') : 'error';
  await record(pool, context, outcome, Date.now() - started);
  if (outcome !== 'blocked') {
    await reportError(lastError, {
      path: `ai:${context.feature}`,
      userId: context.userId,
      organizationId: context.organizationId,
    }).catch(() => undefined);
  }
  throw lastError;
}
