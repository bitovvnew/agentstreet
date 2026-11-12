/**
 * Local configuration. Everything lives in ./.agentstreet/ (or $AGENTSTREET_HOME):
 *
 *   .agentstreet/.env          API keys (KEY=value), chmod 600 where supported
 *   .agentstreet/config.json   chosen models, language, spend limits — no secrets
 *   .agentstreet/.gitignore    "*"  so the folder can never be committed by accident
 *
 * Keys already present in the real environment always win over the file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registerSecret } from '../safety/redact.js';
import type { SpendLimits } from '../safety/limits.js';
import { KEY_ENV, type ProviderId } from '../agents/brains/providers.js';

export interface AppConfig {
  version: 1;
  /** 'llm' = trade with the chosen models; 'offline' = heuristic brains only, no keys. */
  mode: 'llm' | 'offline';
  models: string[];
  /** USD per token for models whose provider publishes prices (used by the $ cap). */
  prices?: Record<string, { input: number; output: number }>;
  limits?: Partial<SpendLimits>;
  language?: string;
  newsWriter?: string | null;
  updated: string;
}

export function configDir(): string {
  return resolve(process.env.AGENTSTREET_HOME || join(process.cwd(), '.agentstreet'));
}

function ensureDir(): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '# AgentStreet local settings and API keys. Never commit.\n*\n');
  return dir;
}

export function readConfig(): AppConfig | null {
  const file = join(configDir(), 'config.json');
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as AppConfig;
    if (c.version !== 1) return null;
    return c;
  } catch {
    return null;
  }
}

export function writeConfig(c: Omit<AppConfig, 'version' | 'updated'>): AppConfig {
  const dir = ensureDir();
  const full: AppConfig = { version: 1, ...c, updated: new Date().toISOString() };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(full, null, 2) + '\n');
  return full;
}

/** Parse a dotenv file (KEY=value, optional quotes, # comments). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** Load .agentstreet/.env into process.env (without overriding real env vars). */
export function loadEnv(): string[] {
  const file = join(configDir(), '.env');
  const loaded: string[] = [];
  if (!existsSync(file)) return loaded;
  const vars = parseEnv(readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(vars)) {
    registerSecret(v);
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
      loaded.push(k);
    }
  }
  return loaded;
}

/** Merge provider keys into .agentstreet/.env and the running process. */
export function saveKeys(keys: Partial<Record<ProviderId, string>>): void {
  const dir = ensureDir();
  const file = join(dir, '.env');
  const vars = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  for (const [p, key] of Object.entries(keys) as [ProviderId, string][]) {
    const name = KEY_ENV[p];
    if (!name || !key) continue;
    const clean = key.trim();
    if (!/^[\x21-\x7e]{8,512}$/.test(clean)) throw new Error(`That does not look like a ${p} API key.`);
    vars[name] = clean;
    process.env[name] = clean;
    registerSecret(clean);
  }
  const body =
    '# AgentStreet API keys — local only, never commit or share this file.\n' +
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') +
    '\n';
  writeFileSync(file, body, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: ACLs instead of modes */
  }
}
