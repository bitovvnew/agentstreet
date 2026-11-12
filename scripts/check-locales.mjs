import { readFileSync, readdirSync } from 'node:fs';
import { LANGUAGES } from '../dashboard/i18n.js';

const folder = new URL('../locales/', import.meta.url);
const locale = (code) => JSON.parse(readFileSync(new URL(`${code}.json`, folder), 'utf8'));
const english = locale('en');
const fields = (value) => (value.match(/\{\w+\}/g) ?? []).sort().join(',');
const expected = LANGUAGES.map(([code]) => `${code}.json`).sort().join(',');
const actual = readdirSync(folder).filter((file) => file.endsWith('.json')).sort().join(',');
if (expected !== actual) throw new Error('The language menu and locale files must match.');

for (const [code] of LANGUAGES) {
  const strings = locale(code);
  if (Object.keys(strings).length !== Object.keys(english).length) throw new Error(`${code}: translation count differs from English`);
  for (const [key, source] of Object.entries(english)) {
    if (typeof strings[key] !== 'string' || !strings[key].trim() || fields(strings[key]) !== fields(source)) {
      throw new Error(`${code}: missing or incompatible translation for ${key}`);
    }
  }
}
console.log(`${LANGUAGES.length} locales, ${Object.keys(english).length} messages each`);
