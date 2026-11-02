import { describe, expect, it } from 'vitest';
import { extractJson, toChatMessages } from './huggingface.js';

describe('Hugging Face adapter', () => {
  it('turns a tool round trip into chat messages with matching ids', () => {
    const messages = toChatMessages('system text', [
      { role: 'user', parts: [{ text: 'How much is due?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'list_invoices', args: { status: 'issued' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'list_invoices', response: { output: [] } } }] },
      { role: 'model', parts: [{ text: 'Nothing is due.' }] },
    ]);
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    const assistant = messages[2] as { tool_calls: { id: string }[] };
    expect((messages[3] as { tool_call_id: string }).tool_call_id).toBe(assistant.tool_calls[0].id);
  });

  it('drops tool results that have no preceding tool call', () => {
    const messages = toChatMessages('s', [
      { role: 'user', parts: [{ functionResponse: { name: 'x', response: {} } }] },
    ]);
    expect(messages).toHaveLength(1);
  });

  it('extracts JSON wrapped in prose or code fences', () => {
    expect(extractJson('Here you go:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson('no json')).toThrow();
  });
});
