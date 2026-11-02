import { GoogleGenAI } from '@google/genai';

export const GEMINI_MODEL = 'gemini-3.8-flash';

export type UnavailableReason = 'disabled' | 'not_configured' | 'budget' | 'timeout';

export class AiUnavailableError extends Error {
  constructor(
    readonly reason: UnavailableReason,
    message: string,
  ) {
    super(message);
  }
}

let client: GoogleGenAI | undefined;

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function gemini(): GoogleGenAI {
  if (!geminiConfigured()) {
    throw new AiUnavailableError('not_configured', 'AI features need GEMINI_API_KEY to be set on the server.');
  }
  client ??= new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  return client;
}

export type AiProvider = 'gemini' | 'huggingface';

/** AI_PROVIDER=huggingface selects Hugging Face; anything else keeps Gemini. */
export function aiProvider(): AiProvider {
  return process.env.AI_PROVIDER?.trim().toLowerCase() === 'huggingface' ? 'huggingface' : 'gemini';
}

/** The model name recorded against each AI call. */
export function activeModelName(): string {
  return aiProvider() === 'huggingface'
    ? process.env.HF_MODEL?.trim() || 'meta-llama/Llama-3.3-70B-Instruct'
    : GEMINI_MODEL;
}
