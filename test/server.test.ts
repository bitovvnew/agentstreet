import { mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Recorder, Simulation, startServer } from '../src/index.js';

it('starts the keyless market from setup and serves the localized terminal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentstreet-test-'));
  vi.stubEnv('AGENTSTREET_HOME', directory);
  let address!: (url: string) => void;
  const listening = new Promise<string>((resolve) => { address = resolve; });
  const server = startServer({
    host: '127.0.0.1',
    port: 0,
    mode: 'live',
    market: null,
    speed: 25,
    maxTicks: 3,
    onListen: address,
    makeMarket: (config) => {
      const sim = new Simulation({ models: config.models });
      return { sim, recorder: new Recorder(sim) };
    },
  });
  try {
    const url = await listening;
    const before = await (await fetch(`${url}/api/state`)).json();
    expect(before.status.phase).toBe('setup');
    expect(await (await fetch(`${url}/locales/ja.json`)).json()).toHaveProperty(['setup.title']);
    const post = (mode: string, headers: Record<string, string>) => fetch(`${url}/api/setup/save`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode, models: ['openai:unused'], language: 'ja' }),
    });
    expect((await post('offline', { origin: 'https://example.com', 'content-type': 'application/json' })).status).toBe(403);
    expect((await post('offline', { 'content-type': 'application/json' })).status).toBe(200);
    await vi.waitFor(async () => {
      const { status } = await (await fetch(`${url}/api/state`)).json();
      expect(status).toMatchObject({ phase: 'live', paused: true, tick: 3 });
    });
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
    expect(config).toMatchObject({ mode: 'offline', models: [], language: 'ja' });
  } finally {
    server.close();
    vi.unstubAllEnvs();
    rmSync(join(directory, 'config.json'), { force: true });
    rmSync(join(directory, '.gitignore'), { force: true });
    rmdirSync(directory);
  }
});
