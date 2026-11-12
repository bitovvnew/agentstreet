// Regenerates docs/img/*.png from DEMO simulations only (fixed seeds, fictional data).
//   npm run screenshots
// Needs Chrome or Edge (set CHROME_PATH to override).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulation, Recorder, startServer } from '../dist/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'img');
const TEMP_ROOT = path.resolve(os.tmpdir());
const TMP = fs.mkdtempSync(path.join(TEMP_ROOT, 'agentstreet-shots-'));
fs.mkdirSync(OUT, { recursive: true });

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const BROWSER = BROWSERS.find((p) => fs.existsSync(p));
if (!BROWSER) throw new Error('No Chrome/Edge found. Set CHROME_PATH.');

async function record(scenario, seed, ticks) {
  const sim = new Simulation({ scenario, seed });
  const rec = new Recorder(sim);
  for (let i = 0; i < ticks; i++) rec.push(await sim.step());
  return rec.toJSON();
}

// Async on purpose: the dashboard server lives in this process and must keep serving.
async function shot(url, file, w, h) {
  await run(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${w},${h}`,
      '--virtual-time-budget=6000',
      `--user-data-dir=${path.join(TMP, 'profile')}`,
      `--screenshot=${path.join(OUT, file)}`,
      url,
    ],
    { timeout: 60_000 },
  );
  console.log('  ✓', file);
}

const shots = [
  { scenario: 'flash-crash', seed: 7, ticks: 420, port: 4711, views: [
    { file: 'flash-crash.png', q: 't=96&sym=QBTX&tf=1&lb=personality&feed=alerts', w: 1600, h: 1000 },
    { file: 'full.png', q: 't=150&sym=QBTX&tf=1&lb=agent&feed=chatter', w: 1600, h: 1270 },
  ] },
  { scenario: 'meme-mania', seed: 4, ticks: 420, port: 4712, views: [
    { file: 'hero.png', q: 't=260&sym=MEOW&tf=5&lb=personality&feed=chatter', w: 1600, h: 1000 },
    { file: 'mobile.png', q: 't=260&sym=MEOW&tf=5', w: 500, h: 900 },
  ] },
];

for (const s of shots) {
  const replay = await record(s.scenario, s.seed, s.ticks);
  const srv = startServer({ port: s.port, host: '127.0.0.1', mode: 'replay', replay });
  await new Promise((r) => setTimeout(r, 300));
  for (const v of s.views) await shot(`http://127.0.0.1:${s.port}/?${v.q}&lang=en`, v.file, v.w, v.h);
  srv.close();
}
if (path.dirname(TMP) === TEMP_ROOT && path.basename(TMP).startsWith('agentstreet-shots-')) {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log('done →', path.relative(ROOT, OUT));
process.exit(0);
