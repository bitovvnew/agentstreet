/**
 * Dependency-free adapters for chat models plus provider catalogs (live model
 * lists, key validation). Model names are never hard-coded: they come from
 * each provider's own /models endpoint.
 *
 *   openai:<model>      OPENAI_API_KEY      (OPENAI_BASE_URL for compatible APIs)
 *   anthropic:<model>   ANTHROPIC_API_KEY
 *   gemini:<model>      GEMINI_API_KEY (or GOOGLE_API_KEY)
 *   openrouter:<model>  OPENROUTER_API_KEY
 *   ollama:<model>      OLLAMA_HOST (default http://localhost:11434), no key
 */
import { redact, registerSecret } from '../../safety/redact.js';

export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'ollama';
export const PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'gemini', 'openrouter', 'ollama'];

export const KEY_ENV: Record<ProviderId, string | null> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: null,
};

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  json?: boolean;
}

export interface ChatResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ChatProvider {
  /** e.g. "anthropic:claude-haiku-5-5" */
  id: string;
  /** USD per input / output token when known (OpenRouter publishes prices). */
  price?: { input: number; output: number };
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** USD per token, when the provider publishes it. */
  price?: { input: number; output: number };
  context?: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(redact(message));
  }
}

function envKey(p: ProviderId): string | undefined {
  if (p === 'gemini') return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
  const name = KEY_ENV[p];
  return name ? process.env[name] || undefined : undefined;
}

export function ollamaHost(): string {
  const h = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
  return /^https?:\/\//.test(h) ? h : `http://${h}`;
}

async function request(url: string, init: RequestInit & { timeoutMs?: number }): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? 20_000);
  if (init.signal) {
    if (init.signal.aborted) ac.abort();
    else init.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) {
      let msg: unknown = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        msg = j.error?.message ?? j.error ?? j.message ?? msg;
      } catch {
        /* keep text */
      }
      throw new ProviderError(`${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError(`Non-JSON response: ${text.slice(0, 160)}`);
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const m = e instanceof Error ? (e.name === 'AbortError' ? 'timed out' : e.message) : String(e);
    throw new ProviderError(m);
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────────────────────── chat ───────────────────────────── */

function openAICompatible(id: string, model: string, baseUrl: string, apiKey: string | null, extraHeaders: Record<string, string> = {}): ChatProvider {
  return {
    id,
    async chat({ system, user, maxTokens = 300, temperature = 0.7, signal, json = true }) {
      const j = await request(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        timeoutMs: 45_000,
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...extraHeaders },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: maxTokens,
          temperature,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      return {
        text: j.choices?.[0]?.message?.content ?? '',
        inputTokens: j.usage?.prompt_tokens ?? 0,
        outputTokens: j.usage?.completion_tokens ?? 0,
      };
    },
  };
}

function anthropicChat(model: string, key: string): ChatProvider {
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  return {
    id: `anthropic:${model}`,
    async chat({ system, user, maxTokens = 300, temperature = 0.7, signal }) {
      const j = await request(`${base}/v1/messages`, {
        method: 'POST',
        signal,
        timeoutMs: 45_000,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, system, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: user }] }),
      });
      const text = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 };
    },
  };
}

function geminiChat(model: string, key: string): ChatProvider {
  return {
    id: `gemini:${model}`,
    async chat({ system, user, maxTokens = 300, temperature = 0.7, signal, json = true }) {
      const j = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal,
        timeoutMs: 45_000,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
        }),
      });
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
      return { text, inputTokens: j.usageMetadata?.promptTokenCount ?? 0, outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0 };
    },
  };
}

/** Parse "provider:model" into a chat provider, using keys from the environment. */
export function createProvider(spec: string, price?: { input: number; output: number }): ChatProvider {
  const i = spec.indexOf(':');
  if (i < 0) throw new ProviderError(`Model spec must look like provider:model, got "${spec}"`);
  const provider = spec.slice(0, i).toLowerCase();
  const model = spec.slice(i + 1);
  const need = (p: ProviderId) => {
    const k = envKey(p);
    if (!k) throw new ProviderError(`No API key for ${p}. Run "agentstreet setup" or set ${KEY_ENV[p]}.`);
    registerSecret(k);
    return k;
  };
  let p: ChatProvider;
  switch (provider) {
    case 'openai':
      p = openAICompatible(spec, model, (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''), need('openai'));
      break;
    case 'anthropic':
    case 'claude':
      p = anthropicChat(model, need('anthropic'));
      break;
    case 'gemini':
    case 'google':
      p = geminiChat(model, need('gemini'));
      break;
    case 'openrouter':
      p = openAICompatible(spec, model, 'https://openrouter.ai/api/v1', need('openrouter'), {
        'HTTP-Referer': 'https://github.com/bitovvnew/agentstreet',
        'X-Title': 'AgentStreet',
      });
      break;
    case 'ollama':
      p = openAICompatible(spec, model, `${ollamaHost()}/v1`, null);
      break;
    default:
      throw new ProviderError(`Unknown provider "${provider}". Use openai, anthropic, gemini, openrouter or ollama.`);
  }
  return price ? { ...p, price } : p;
}

/* ───────────────────────────── catalogs ───────────────────────────── */

const NOT_CHAT = /(embed|whisper|tts|audio|realtime|dall-e|image|moderation|transcribe|search|computer-use|babbage|davinci|-instruct|sora)/i;

/**
 * List chat-capable models. Doubles as key validation: every call is
 * authenticated, so a bad key fails here at zero token cost.
 */
export async function listModels(provider: ProviderId, key?: string): Promise<ModelInfo[]> {
  const k = key ?? envKey(provider);
  if (k) registerSecret(k);
  switch (provider) {
    case 'openai': {
      if (!k) throw new ProviderError('missing key');
      const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
      const j = await request(`${base}/models`, { headers: { authorization: `Bearer ${k}` } });
      return (j.data ?? [])
        .map((m: any) => String(m.id))
        .filter((id: string) => !NOT_CHAT.test(id))
        .sort()
        .map((id: string) => ({ id, name: id }));
    }
    case 'anthropic': {
      if (!k) throw new ProviderError('missing key');
      const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
      const j = await request(`${base}/v1/models?limit=100`, { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } });
      return (j.data ?? []).map((m: any) => ({ id: String(m.id), name: String(m.display_name ?? m.id) }));
    }
    case 'gemini': {
      if (!k) throw new ProviderError('missing key');
      const j = await request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': k } });
      return (j.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent') && !NOT_CHAT.test(m.name))
        .map((m: any) => ({ id: String(m.name).replace(/^models\//, ''), name: String(m.displayName ?? m.name), context: m.inputTokenLimit }));
    }
    case 'openrouter': {
      if (!k) throw new ProviderError('missing key');
      // The public model list works without a key, so validate the key explicitly first.
      await request('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${k}` } });
      const j = await request('https://openrouter.ai/api/v1/models', { headers: { authorization: `Bearer ${k}` } });
      return (j.data ?? [])
        .filter((m: any) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text'))
        .map((m: any) => {
          const pi = Number(m.pricing?.prompt);
          const po = Number(m.pricing?.completion);
          return {
            id: String(m.id),
            name: String(m.name ?? m.id),
            context: m.context_length,
            ...(Number.isFinite(pi) && Number.isFinite(po) ? { price: { input: pi, output: po } } : {}),
          };
        });
    }
    case 'ollama': {
      const j = await request(`${ollamaHost()}/api/tags`, { timeoutMs: 2_500 });
      return (j.models ?? []).map((m: any) => ({ id: String(m.name), name: String(m.name) }));
    }
  }
}

/** Is a local Ollama running? Returns its models, or null. */
export async function detectOllama(): Promise<ModelInfo[] | null> {
  try {
    return await listModels('ollama');
  } catch {
    return null;
  }
}

/** Which keys are already present in the environment (values never returned). */
export function envKeysPresent(): Record<ProviderId, boolean> {
  return {
    openai: !!envKey('openai'),
    anthropic: !!envKey('anthropic'),
    gemini: !!envKey('gemini'),
    openrouter: !!envKey('openrouter'),
    ollama: false,
  };
}

/** A tiny round trip to prove a specific model answers. */
export async function pingModel(spec: string): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const p = createProvider(spec);
    await p.chat({ system: 'Reply with the single word: ok', user: 'ping', maxTokens: 5, temperature: 0, json: false });
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: redact(e instanceof Error ? e.message : String(e)) };
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
