/**
 * Secret hygiene. Anything that might end up in a log line, an error shown in
 * the dashboard, or a replay file goes through redact() first.
 */

const known = new Set<string>();

/** Register a secret value so it is scrubbed verbatim wherever it appears. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) known.add(value);
}

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sk-or-[A-Za-z0-9_-]{8,}/g, // OpenRouter
  /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g, // OpenAI
  /AIza[0-9A-Za-z_-]{20,}/g, // Google
  /(?<=[?&](?:key|api_key|apikey|token)=)[^&\s"']+/gi, // keys in query strings
  /(?<=(?:authorization|x-api-key|x-goog-api-key)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[A-Za-z0-9._-]{12,}/gi,
];

export function redact(text: string): string {
  let out = String(text);
  for (const k of known) out = out.split(k).join('[redacted]');
  for (const re of PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

/** "sk-…a1b2" style hint for showing that a key is configured without revealing it. */
export function maskKey(key: string | undefined | null): string {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}
