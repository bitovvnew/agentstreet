/**
 * Minimal, dependency-free chat adapters. Each returns the model's text and
 * token usage. Keys come from the environment; nothing is ever logged.
 *
 *   openai:<model>      OPENAI_API_KEY   (OPENAI_BASE_URL to use any compatible API)
 *   anthropic:<model>   ANTHROPIC_API_KEY
 *   gemini:<model>      GEMINI_API_KEY (or GOOGLE_API_KEY)
 *   ollama:<model>      OLLAMA_HOST (default http://localhost:11434), no key
 */

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ChatProvider {
  /** e.g. "anthropic:claude-haiku-5-5" */
  id: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export class ProviderError extends Error {}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new ProviderError(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`Non-JSON response: ${text.slice(0, 200)}`);
  }
}

function need(name: string, ...alts: string[]): string {
  for (const n of [name, ...alts]) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new ProviderError(`Missing ${name} in the environment`);
}

export function openAICompatible(id: string, model: string, baseUrl: string, apiKey: string | null): ChatProvider {
  return {
    id,
    async chat({ system, user, maxTokens = 400, temperature = 0.7, signal }) {
      const j = await postJson(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: maxTokens,
          temperature,
          response_format: { type: 'json_object' },
        },
        signal,
      );
      return {
        text: j.choices?.[0]?.message?.content ?? '',
        inputTokens: j.usage?.prompt_tokens ?? 0,
        outputTokens: j.usage?.completion_tokens ?? 0,
      };
    },
  };
}

export function anthropic(model: string): ChatProvider {
  return {
    id: `anthropic:${model}`,
    async chat({ system, user, maxTokens = 400, temperature = 0.7, signal }) {
      const base = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
      const j = await postJson(
        `${base.replace(/\/$/, '')}/v1/messages`,
        { 'x-api-key': need('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
        { model, system, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: user }] },
        signal,
      );
      const text = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 };
    },
  };
}

export function gemini(model: string): ChatProvider {
  return {
    id: `gemini:${model}`,
    async chat({ system, user, maxTokens = 400, temperature = 0.7, signal }) {
      const key = need('GEMINI_API_KEY', 'GOOGLE_API_KEY');
      const j = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': key },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature, responseMimeType: 'application/json' },
        },
        signal,
      );
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
      return { text, inputTokens: j.usageMetadata?.promptTokenCount ?? 0, outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0 };
    },
  };
}

/** Parse "provider:model" into a provider. */
export function createProvider(spec: string): ChatProvider {
  const i = spec.indexOf(':');
  if (i < 0) throw new ProviderError(`Model spec must look like provider:model, got "${spec}"`);
  const provider = spec.slice(0, i).toLowerCase();
  const model = spec.slice(i + 1);
  switch (provider) {
    case 'openai':
      return openAICompatible(spec, model, process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', need('OPENAI_API_KEY'));
    case 'anthropic':
    case 'claude':
      return anthropic(model);
    case 'gemini':
    case 'google':
      return gemini(model);
    case 'ollama':
      return openAICompatible(spec, model, `${(process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '')}/v1`, null);
    default:
      throw new ProviderError(`Unknown provider "${provider}". Use openai, anthropic, gemini or ollama.`);
  }
}

/** Pull the first JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ProviderError('No JSON object in reply');
  return JSON.parse(body.slice(start, end + 1));
}
