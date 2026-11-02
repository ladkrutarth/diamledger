import type { Content, FunctionCall, Part } from '@google/genai';
import type { AssistantModel, ModelReply } from '../assistant/agent.js';
import type { DraftReminderText } from '../reminders.js';
import { AiUnavailableError } from './client.js';

/**
 * Hugging Face Inference Providers, through its OpenAI-compatible chat endpoint.
 * Set AI_PROVIDER=huggingface and HF_TOKEN (a token with "Make calls to Inference Providers").
 */
export const DEFAULT_HF_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';

const HF_BASE_URL = 'https://router.huggingface.co/v1';

export function hfConfigured(): boolean {
  return Boolean(process.env.HF_TOKEN);
}

export function hfModel(): string {
  return process.env.HF_MODEL?.trim() || DEFAULT_HF_MODEL;
}

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type ChatTool = { type: 'function'; function: { name: string; description: string; parameters: unknown } };

type ChatResponse = {
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

class HfError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function chat(
  messages: ChatMessage[],
  options: { tools?: ChatTool[]; signal?: AbortSignal; temperature?: number },
): Promise<ChatResponse> {
  if (!hfConfigured()) {
    throw new AiUnavailableError('not_configured', 'AI features need HF_TOKEN to be set on the server.');
  }
  const response = await fetch(`${HF_BASE_URL}/chat/completions`, {
    method: 'POST',
    signal: options.signal,
    headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: hfModel(),
      messages,
      temperature: options.temperature ?? 0.2,
      ...(options.tools?.length ? { tools: options.tools, tool_choice: 'auto' } : {}),
    }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new HfError(`Hugging Face request failed (${response.status}): ${detail}`, response.status);
  }
  return (await response.json()) as ChatResponse;
}

function textOf(parts: Part[]): string {
  return parts
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join('');
}

/** Turns the stored Gemini-shaped conversation into OpenAI chat messages. */
export function toChatMessages(system: string, contents: Content[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  let pendingIds: string[] = [];
  contents.forEach((content, index) => {
    const parts = content.parts ?? [];
    const calls = parts.filter((part) => part.functionCall);
    const responses = parts.filter((part) => part.functionResponse);
    const text = textOf(parts);
    if (content.role === 'model') {
      if (calls.length) {
        pendingIds = calls.map((part, i) => part.functionCall?.id || `call_${index}_${i}`);
        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: calls.map((part, i) => ({
            id: pendingIds[i],
            type: 'function',
            function: { name: part.functionCall?.name ?? '', arguments: JSON.stringify(part.functionCall?.args ?? {}) },
          })),
        });
      } else if (text) {
        messages.push({ role: 'assistant', content: text });
      }
    } else if (responses.length) {
      // Tool results are only valid right after the assistant message that asked for them.
      if (pendingIds.length) {
        responses.forEach((part, i) => {
          messages.push({
            role: 'tool',
            tool_call_id: pendingIds[i] ?? `call_${index}_${i}`,
            content: JSON.stringify(part.functionResponse?.response ?? {}),
          });
        });
      }
      pendingIds = [];
    } else if (text) {
      messages.push({ role: 'user', content: text });
    }
  });
  return messages;
}

export const hfAssistantModel: AssistantModel = async ({ system, contents, tools }, signal) => {
  const response = await chat(toChatMessages(system, contents), {
    signal,
    tools: tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parametersJsonSchema },
    })),
  });
  const message = response.choices?.[0]?.message;
  const text = message?.content ?? '';
  const functionCalls: FunctionCall[] = (message?.tool_calls ?? []).map((call) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      // A malformed argument string is passed on as empty; the tool's own validation will refuse it.
    }
    return { id: call.id, name: call.function.name, args };
  });
  const parts: Part[] = [
    ...(text ? [{ text }] : []),
    ...functionCalls.map((call) => ({ functionCall: call })),
  ];
  const reply: ModelReply = {
    text,
    functionCalls: functionCalls.length ? functionCalls : undefined,
    content: { role: 'model', parts },
    usage: { inputTokens: response.usage?.prompt_tokens, outputTokens: response.usage?.completion_tokens },
  };
  return reply;
};

/** Pulls the first JSON object out of a model reply, which may be wrapped in prose or code fences. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The model did not return JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

export async function hfJson(
  system: string,
  user: string,
  shape: string,
  signal?: AbortSignal,
): Promise<{ value: unknown; usage: { inputTokens?: number; outputTokens?: number } }> {
  const response = await chat(
    [
      { role: 'system', content: `${system}\n\nReply with one JSON object only, no other text, shaped like:\n${shape}` },
      { role: 'user', content: user },
    ],
    { signal },
  );
  return {
    value: extractJson(response.choices?.[0]?.message?.content ?? ''),
    usage: { inputTokens: response.usage?.prompt_tokens, outputTokens: response.usage?.completion_tokens },
  };
}

export const REMINDER_SHAPE = '{"subject": string, "greeting": string, "paragraphs": string[]}';

export const MANIFEST_SHAPE = `{
  "consigneeName": string,
  "portOfDestination": string,
  "kpcsNumber": string,
  "items": [{"description": string, "hsCode": string, "certificateNo": string, "parcelId": string, "pieces": integer, "carats": number, "ratePerCarat": number}],
  "notes": string
}`;

export function hfReminderText(system: string): DraftReminderText {
  return async (facts, signal) => {
    const { value, usage } = await hfJson(
      system,
      `Tone: ${facts.tone}\nBuyer company: ${facts.buyerName || 'not given'}\n`
        + `Buyer contact person: ${facts.contactPerson || 'not given'}\nExporter company: ${facts.exporterName || 'not given'}`,
      REMINDER_SHAPE,
      signal,
    );
    return { ...(value as { subject: string; greeting: string; paragraphs: string[] }), usage };
  };
}
