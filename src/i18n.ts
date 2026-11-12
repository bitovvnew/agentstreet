import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Languages shipped in locales/*.json. English is the source of truth. */
export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Русский' },
  { code: 'kk', name: 'Қазақша' },
  { code: 'fr', name: 'Français' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'ko', name: '한국어' },
  { code: 'es', name: 'Español' },
  { code: 'ja', name: '日本語' },
] as const;

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'locales');
const cache = new Map<string, Record<string, string>>();

function load(code: string): Record<string, string> {
  if (cache.has(code)) return cache.get(code)!;
  const file = join(DIR, `${code}.json`);
  const dict = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
  cache.set(code, dict);
  return dict;
}

/** Best supported language for a BCP-47 tag or POSIX locale (e.g. "ru_RU.UTF-8"). */
export function matchLanguage(tag: string | undefined | null): string {
  const t = String(tag ?? '').replace('_', '-').split('.')[0]!.toLowerCase();
  if (t.startsWith('zh')) return 'zh-CN';
  const base = t.split('-')[0];
  return LANGUAGES.find((l) => l.code === base)?.code ?? 'en';
}

export function detectLanguage(): string {
  return matchLanguage(process.env.AGENTSTREET_LANG || process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale);
}

/** Translator for one language with English fallback and {param} interpolation. */
export function translator(code: string) {
  const dict = load(code);
  const en = load('en');
  return (key: string, params: Record<string, string | number> = {}) => {
    const s = dict[key] ?? en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
  };
}
