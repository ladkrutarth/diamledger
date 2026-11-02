import type { Express } from 'express';
import { Type } from '@google/genai';
import { callModel, usageFrom } from '../../ai/call.js';
import { AiUnavailableError, GEMINI_MODEL, activeModelName, aiProvider, gemini } from '../../ai/client.js';
import { hfJson } from '../../ai/huggingface.js';
import type { DbPool } from '../../core/db.js';
import { asyncHandler, currentUser } from '../../core/http.js';
import { parseLooseDate, taxWriter } from '../tax/taxShared.js';

const STATEMENT_PROMPT_VERSION = 'bank-statement-v1';
const MAX_LINES = 500;
const FILE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

const SYSTEM_PROMPT = `You read bank statements for an Indian diamond exporter's USD (EEFC or export) account.
Return only CREDIT entries (money received). Ignore debits, charges, opening and closing balances, and totals.
For each credit give:
- date: the value date, or the transaction date, as YYYY-MM-DD
- amountUsd: the credited amount in US dollars, as a number with no commas
- reference: the UTR, SWIFT, or bank reference number, if shown
- narration: the description, including the remitter name and any invoice numbers
- bankRateInr: the rupee conversion rate if the statement shows one, otherwise leave it out
Copy numbers and references exactly as printed. Never invent a line.`;

const SHAPE = '{"lines": [{"date": "YYYY-MM-DD", "amountUsd": number, "reference": string, "narration": string, "bankRateInr": number}]}';

export type StatementLine = { date: string; amountUsd: number; reference: string; narration: string; bankRateInr: number | null };

/** Keeps only lines that look like real credits; the model's output is never trusted as-is. */
export function cleanStatementLines(raw: unknown): StatementLine[] {
  const list = Array.isArray((raw as { lines?: unknown })?.lines) ? (raw as { lines: unknown[] }).lines : [];
  const lines: StatementLine[] = [];
  for (const entry of list.slice(0, MAX_LINES)) {
    const line = (entry ?? {}) as Record<string, unknown>;
    const date = parseLooseDate(typeof line.date === 'string' ? line.date : undefined);
    const amount = Number(String(line.amountUsd ?? '').replace(/[,\s$]/g, ''));
    const rate = Number(line.bankRateInr);
    if (!date || !Number.isFinite(amount) || amount <= 0) continue;
    lines.push({
      date,
      amountUsd: Math.round(amount * 100) / 100,
      reference: typeof line.reference === 'string' ? line.reference.trim().slice(0, 200) : '',
      narration: typeof line.narration === 'string' ? line.narration.trim().slice(0, 500) : '',
      bankRateInr: Number.isFinite(rate) && rate > 0 && rate < 1000 ? rate : null,
    });
  }
  return lines;
}

export function registerStatementReaderRoutes(app: Express, pool: DbPool): void {
  app.post('/api/bank/parse-statement', taxWriter, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 200_000) : '';
    const fileBase64 = typeof req.body?.fileBase64 === 'string' ? req.body.fileBase64.replace(/^data:[^;]+;base64,/, '') : '';
    const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType : '';
    if (!text && !fileBase64) return res.status(400).json({ error: 'Upload a PDF, an image, or a CSV of the statement.' });
    if (fileBase64 && !FILE_TYPES.has(mimeType)) {
      return res.status(400).json({ error: 'The AI reader takes PDF, PNG, JPEG, or WebP. Save Excel statements as CSV or PDF first.' });
    }

    const context = {
      feature: 'bank_statement' as const,
      promptVersion: STATEMENT_PROMPT_VERSION,
      model: activeModelName(),
      organizationId: user.organizationId,
      userId: user.id,
    };
    try {
      const parsed = await callModel<unknown>(pool, context, async (signal) => {
        if (aiProvider() === 'huggingface') {
          if (fileBase64) {
            throw new AiUnavailableError('not_configured', 'Reading PDF or image statements needs AI_PROVIDER=gemini. Upload a CSV instead.');
          }
          return hfJson(SYSTEM_PROMPT, `Bank statement:\n\n${text}`, SHAPE, signal);
        }
        const parts = fileBase64
          ? [{ inlineData: { mimeType, data: fileBase64 } }, { text: 'Read the credits from this bank statement.' }]
          : [{ text: `Read the credits from this bank statement:\n\n${text}` }];
        const result = await gemini().models.generateContent({
          model: GEMINI_MODEL,
          contents: { parts },
          config: {
            abortSignal: signal,
            systemInstruction: SYSTEM_PROMPT,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                lines: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      date: { type: Type.STRING, description: 'Value date as YYYY-MM-DD' },
                      amountUsd: { type: Type.NUMBER, description: 'Credited amount in USD' },
                      reference: { type: Type.STRING, description: 'UTR, SWIFT, or bank reference' },
                      narration: { type: Type.STRING, description: 'Description including remitter and invoice numbers' },
                      bankRateInr: { type: Type.NUMBER, description: 'Rupee conversion rate, if printed' },
                    },
                    required: ['date', 'amountUsd'],
                  },
                },
              },
              required: ['lines'],
            },
          },
        });
        return { value: JSON.parse(result.text || '{}'), usage: usageFrom(result.usageMetadata) };
      });
      const lines = cleanStatementLines(parsed);
      return res.json({ lines, model: activeModelName() });
    } catch (error) {
      if (error instanceof AiUnavailableError) return res.status(503).json({ error: error.message });
      console.error('Statement reader failed:', (error as Error).message);
      return res.status(502).json({ error: 'The AI could not read that statement. Try a clearer PDF, or upload it as CSV.' });
    }
  }));
}
