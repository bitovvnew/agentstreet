// Tiny i18n: locale JSON files, English fallback, {param} interpolation, data-i18n attributes.

export const LANGUAGES = [
  ['en', 'English'],
  ['ru', 'Русский'],
  ['kk', 'Қазақша'],
  ['fr', 'Français'],
  ['zh-CN', '简体中文'],
  ['ko', '한국어'],
  ['es', 'Español'],
  ['ja', '日本語'],
];

let dict = {};
let en = {};
export let lang = 'en';

export function match(tag) {
  const t = String(tag || '').toLowerCase();
  if (t.startsWith('zh')) return 'zh-CN';
  const base = t.split(/[-_]/)[0];
  return LANGUAGES.find(([c]) => c === base)?.[0] ?? 'en';
}

/** URL ?lang= > saved choice > config > browser languages. */
export function pick(configured) {
  const q = new URLSearchParams(location.search).get('lang');
  let saved = null;
  try {
    saved = localStorage.getItem('as-lang');
  } catch {}
  return match(q || saved || configured || navigator.languages?.[0] || navigator.language);
}

async function fetchDict(code) {
  const r = await fetch(`locales/${code}.json`);
  return r.ok ? r.json() : {};
}

export async function setLanguage(code, persist = false) {
  lang = match(code);
  if (!Object.keys(en).length) en = await fetchDict('en');
  dict = lang === 'en' ? en : await fetchDict(lang);
  document.documentElement.lang = lang;
  if (persist) {
    try {
      localStorage.setItem('as-lang', lang);
    } catch {}
  }
  apply();
}

export function t(key, params = {}) {
  const s = dict[key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? `{${k}}`));
}

/** Fill [data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria]. */
export function apply(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}

/** Locale-aware number formatting with tabular output. */
export function num(x, d = 2) {
  return Number(x).toLocaleString(lang, { minimumFractionDigits: d, maximumFractionDigits: d });
}
