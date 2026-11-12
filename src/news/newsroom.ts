import type { Rng } from '../core/rng.js';
import type { SymbolSpec } from '../core/types.js';
import { SECTOR_PRODUCTS } from '../sim/universe.js';

export type NewsKind =
  | 'earnings'
  | 'product'
  | 'legal'
  | 'analyst'
  | 'rumor'
  | 'social'
  | 'scandal'
  | 'macro'
  | 'confirm'
  | 'debunk'
  | 'central-bank'
  | 'breaking';

export interface NewsItem {
  id: number;
  tick: number;
  symbol: string | null;
  kind: NewsKind;
  headline: string;
  /** -1 (terrible) .. +1 (euphoric): how the story *reads*. */
  sentiment: number;
  /**
   * Real change to fundamental value (log-return). Hidden from agents:
   * they only see the headline, sentiment and hype.
   */
  impact: number;
  /** Extra excitement that is NOT backed by fundamentals (log-return). */
  hype: number;
  source: 'wire' | 'rumor-mill' | 'social' | 'macro' | 'desk' | 'user' | 'llm';
  rumor?: { resolvesAt: number; isTrue: boolean; potential: number };
  /** For confirm/debunk follow-ups: the original rumor id. */
  followUpOf?: number;
}

/** The view agents get: no ground truth. */
export type PublicNews = Omit<NewsItem, 'impact' | 'rumor'> & { isRumor: boolean };

export function publicNews(n: NewsItem): PublicNews {
  const { impact: _i, rumor, ...rest } = n;
  return { ...rest, isRumor: !!rumor };
}

export interface NewsSpec {
  symbol: string | null;
  kind: NewsKind;
  tone: 'positive' | 'negative';
  /** Overrides the generated headline. */
  headline?: string;
  /** 0..1 scale of how big the story is. */
  magnitude?: number;
  source?: NewsItem['source'];
}

/** Optional LLM that rewrites a generated headline. Must return one line. */
export type HeadlineWriter = (draft: { headline: string; kind: NewsKind; company?: string; tone: string }) => Promise<string | null>;

const FIRMS = ['Grubman & Pals', 'Sachs Fifth Avenue', 'Morgan Stanleyish', 'Lehman Sisters', 'Bear Hug Capital', 'Bluebird Research'];
const BIDDERS = ['a sovereign wealth fund', 'a mystery megacap', 'a Silicon Valley giant', 'three private-equity firms', 'an eccentric billionaire'];

function pct(rng: Rng, lo: number, hi: number): number {
  return rng.range(lo, hi);
}

/**
 * Generates fictional market news. Each item carries a hidden fundamental
 * impact and a visible "hype" component, so prices can over- and
 * under-shoot the truth. Rumors resolve later as confirmed or debunked.
 */
export class Newsroom {
  private nextId = 1;
  readonly items: NewsItem[] = [];
  private pendingRumors: NewsItem[] = [];

  constructor(
    private readonly rng: Rng,
    private readonly universe: SymbolSpec[],
    /** Expected stories per tick. */
    public rate = 0.06,
  ) {}

  /** Generate (maybe) one random story plus any rumor resolutions due this tick. */
  tick(t: number, tilt = 0): NewsItem[] {
    const out: NewsItem[] = [];
    for (const r of [...this.pendingRumors]) {
      if (r.rumor && t >= r.rumor.resolvesAt) {
        this.pendingRumors = this.pendingRumors.filter((x) => x !== r);
        out.push(this.resolveRumor(r, t));
      }
    }
    if (this.rng.chance(this.rate)) out.push(this.random(t, tilt));
    return out;
  }

  private add(n: Omit<NewsItem, 'id'>): NewsItem {
    const item = { ...n, id: this.nextId++ } as NewsItem;
    this.items.push(item);
    if (item.rumor) this.pendingRumors.push(item);
    return item;
  }

  private random(t: number, tilt: number): NewsItem {
    const rng = this.rng;
    const kind = rng.weighted<NewsKind>([
      ['earnings', 18],
      ['product', 18],
      ['analyst', 16],
      ['rumor', 12],
      ['social', 11],
      ['legal', 8],
      ['scandal', 7],
      ['macro', 10],
    ]);
    const positive = rng.chance(Math.min(0.85, Math.max(0.15, 0.53 + tilt)));
    return this.make({ kind, tone: positive ? 'positive' : 'negative', symbol: kind === 'macro' ? null : rng.pick(this.universe).symbol }, t);
  }

  /** Build a story from a spec (used by scenarios and the dashboard's "inject news"). */
  make(spec: NewsSpec, t: number): NewsItem {
    const rng = this.rng;
    const s = spec.symbol ? this.universe.find((u) => u.symbol === spec.symbol) : undefined;
    const name = s?.name ?? 'The market';
    const tk = s?.symbol ?? '';
    const pos = spec.tone === 'positive';
    const sign = pos ? 1 : -1;
    const m = spec.magnitude ?? rng.range(0.4, 1);
    const product = s ? rng.pick(SECTOR_PRODUCTS[s.sector] ?? ['product']) : 'product';
    let headline = '';
    let impact = 0;
    let hype = 0;
    let sentiment = sign * rng.range(0.4, 0.9);
    let source: NewsItem['source'] = spec.source ?? 'wire';
    let rumor: NewsItem['rumor'];

    switch (spec.kind) {
      case 'earnings': {
        const est = rng.range(0.4, 3.2);
        const act = pos ? est * rng.range(1.08, 1.45) : est * rng.range(0.55, 0.92);
        headline = pos
          ? rng.pick([
              `${name} smashes estimates: EPS $${act.toFixed(2)} vs $${est.toFixed(2)} expected`,
              `${name} beats on revenue and raises full-year guidance`,
              `${tk} posts record quarter; CFO "cautiously ecstatic"`,
            ])
          : rng.pick([
              `${name} misses: EPS $${act.toFixed(2)} vs $${est.toFixed(2)} expected`,
              `${name} cuts guidance "out of an abundance of caution"`,
              `${tk} revenue slides; management blames "the macro"`,
            ]);
        impact = sign * pct(rng, 0.03, 0.09) * m;
        hype = sign * pct(rng, 0.0, 0.03) * m;
        break;
      }
      case 'product':
        headline = pos
          ? rng.pick([
              `${name} unveils ${product}; preorders crash the website`,
              `${name}'s ${product} gets regulatory green light`,
              `${tk} signs mega-deal to ship ${product} to 40 countries`,
            ])
          : rng.pick([
              `${name} recalls ${product} after "unexpected behaviour"`,
              `${name} delays ${product} to next year`,
              `Reviewers call ${name}'s ${product} "a very expensive paperweight"`,
            ]);
        impact = sign * pct(rng, 0.02, 0.07) * m;
        hype = sign * pct(rng, 0.01, 0.05) * m;
        break;
      case 'analyst': {
        const firm = rng.pick(FIRMS);
        headline = pos ? `${firm} upgrades ${tk} to BUY, sees "multi-bagger"` : `${firm} downgrades ${tk} to SELL, cites "vibes"`;
        impact = sign * pct(rng, 0, 0.01);
        hype = sign * pct(rng, 0.02, 0.04) * m;
        sentiment = sign * rng.range(0.3, 0.6);
        source = 'desk';
        break;
      }
      case 'rumor': {
        const isTrue = rng.chance(0.38);
        const potential = sign * pct(rng, 0.08, 0.18);
        headline = pos
          ? `RUMOR: ${name} in buyout talks with ${rng.pick(BIDDERS)} at ${rng.int(25, 60)}% premium`
          : `RUMOR: ${name} under investigation by the Street Commission, sources say`;
        impact = 0;
        hype = sign * pct(rng, 0.05, 0.1) * m;
        sentiment = sign * rng.range(0.5, 0.9);
        source = 'rumor-mill';
        rumor = { resolvesAt: t + rng.int(60, 180), isTrue, potential };
        break;
      }
      case 'social':
        headline = pos
          ? rng.pick([`#${tk}ToTheMoon trends as retail army piles in`, `Influencer with 9M followers: "${tk} is the next big thing, trust me"`])
          : rng.pick([`Viral thread claims ${tk} is "basically a pyramid"`, `#Dump${tk} trends after a meme goes viral`]);
        impact = 0;
        hype = sign * pct(rng, 0.03, 0.08) * m;
        sentiment = sign * rng.range(0.4, 0.8);
        source = 'social';
        break;
      case 'legal':
        headline = pos
          ? `${name} wins patent case; rival ordered to pay damages`
          : `${name} hit with class-action over ${product}`;
        impact = sign * pct(rng, 0.02, 0.05) * m;
        hype = sign * pct(rng, 0.0, 0.02);
        break;
      case 'scandal':
        headline = pos
          ? `${name} CEO steps down; investors cheer`
          : rng.pick([
              `${name} CEO livestreams board meeting from a yacht`,
              `${name} CFO caught expensing a pet tiger`,
              `Whistleblower: ${name} "rounded up" user numbers by 300%`,
            ]);
        impact = sign * pct(rng, 0.02, 0.06) * m;
        hype = sign * pct(rng, 0.01, 0.04);
        break;
      case 'macro':
        headline = pos
          ? rng.pick(['Inflation cools faster than expected', 'Jobs report blows past forecasts', 'Consumer confidence at a 3-year high'])
          : rng.pick(['Inflation print runs hot; rate-hike odds jump', 'Factory orders slump for a third month', 'Bond yields spike as deficit fears return']);
        impact = sign * pct(rng, 0.005, 0.02) * m;
        hype = sign * pct(rng, 0.005, 0.015);
        sentiment = sign * rng.range(0.3, 0.7);
        source = 'macro';
        break;
      case 'breaking':
        headline = pos ? `BREAKING: ${name} surges on unconfirmed reports` : `BREAKING: ${name} plunges on unconfirmed reports`;
        impact = sign * pct(rng, 0.02, 0.05) * m;
        hype = sign * pct(rng, 0.04, 0.08) * m;
        sentiment = sign * 0.9;
        break;
      default:
        headline = `${name} in the news`;
    }

    return this.add({
      tick: t,
      symbol: spec.symbol,
      kind: spec.kind,
      headline: spec.headline ?? headline,
      sentiment,
      impact,
      hype,
      source,
      rumor,
    });
  }

  private resolveRumor(r: NewsItem, t: number): NewsItem {
    const s = this.universe.find((u) => u.symbol === r.symbol);
    const name = s?.name ?? r.symbol ?? 'Company';
    const sign = Math.sign(r.rumor!.potential) || 1;
    if (r.rumor!.isTrue) {
      return this.add({
        tick: t,
        symbol: r.symbol,
        kind: 'confirm',
        headline: sign > 0 ? `CONFIRMED: ${name} agrees to be acquired; deal values stock well above market` : `CONFIRMED: Street Commission formally charges ${name}`,
        sentiment: sign * 0.95,
        impact: r.rumor!.potential,
        hype: sign * 0.02,
        source: 'wire',
        followUpOf: r.id,
      });
    }
    return this.add({
      tick: t,
      symbol: r.symbol,
      kind: 'debunk',
      headline: sign > 0 ? `${name} denies buyout talks: "We are not for sale"` : `${name} cleared; investigation rumor was fake`,
      sentiment: -sign * 0.6,
      impact: 0,
      hype: -r.hype,
      source: 'wire',
      followUpOf: r.id,
    });
  }

  /** A central-bank decision story (rate in decimal, e.g. 0.0525). */
  centralBank(t: number, from: number, to: number): NewsItem {
    const bps = Math.round((to - from) * 10_000);
    const headline =
      bps > 0
        ? `Central bank HIKES rates by ${bps}bp to ${(to * 100).toFixed(2)}%`
        : bps < 0
          ? `Central bank CUTS rates by ${-bps}bp to ${(to * 100).toFixed(2)}%`
          : `Central bank holds rates at ${(to * 100).toFixed(2)}%`;
    return this.add({
      tick: t,
      symbol: null,
      kind: 'central-bank',
      headline,
      sentiment: bps > 0 ? -0.6 : bps < 0 ? 0.6 : 0,
      impact: 0,
      hype: 0,
      source: 'macro',
    });
  }

  recent(n: number): NewsItem[] {
    return this.items.slice(-n);
  }
}
