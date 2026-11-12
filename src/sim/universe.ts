import type { SymbolSpec } from '../core/types.js';

/**
 * The default listing. Every company here is FICTIONAL; any resemblance to a
 * real ticker or business is coincidental.
 */
export const DEFAULT_UNIVERSE: SymbolSpec[] = [
  {
    symbol: 'GRDX',
    name: 'NovaGrid Energy',
    sector: 'Energy',
    price: 8_420,
    shares: 410_000_000,
    vol: 0.32,
    blurb: 'Grid-scale batteries and a suspiciously optimistic fusion roadmap.',
  },
  {
    symbol: 'QBTX',
    name: 'Qubitron Systems',
    sector: 'Quantum',
    price: 21_250,
    shares: 180_000_000,
    vol: 0.55,
    blurb: 'Quantum chips that work beautifully at 0.01 Kelvin and in press releases.',
  },
  {
    symbol: 'MEOW',
    name: 'CatNet Media',
    sector: 'Social',
    price: 3_140,
    shares: 900_000_000,
    vol: 0.7,
    blurb: 'A social network for cats. Run by cats. Monetised by humans.',
  },
  {
    symbol: 'BRGR',
    name: 'BurgerBot Robotics',
    sector: 'Robotics',
    price: 5_780,
    shares: 300_000_000,
    vol: 0.42,
    blurb: 'Robot arms that flip 400 burgers an hour and occasionally the cashier.',
  },
  {
    symbol: 'HLXB',
    name: 'Helix Biolabs',
    sector: 'Biotech',
    price: 4_610,
    shares: 250_000_000,
    vol: 0.75,
    blurb: 'One longevity pill in phase III. One CEO who says he is 140.',
  },
  {
    symbol: 'ORBF',
    name: 'Orbital Freight',
    sector: 'Space',
    price: 12_890,
    shares: 220_000_000,
    vol: 0.5,
    blurb: 'Same-day delivery to low Earth orbit. Returns are complicated.',
  },
];

/** Things each sector ships, used by the newsroom to write headlines. */
export const SECTOR_PRODUCTS: Record<string, string[]> = {
  Energy: ['grid-scale battery', 'fusion-assisted turbine', 'solar roof tile', 'hydrogen truck depot'],
  Quantum: ['1,024-qubit chip', 'error-corrected processor', 'quantum cloud tier', 'room-temperature qubit demo'],
  Social: ['AI cat-filter', 'paid meow-verification', 'short-video feed for kittens', 'catfluencer marketplace'],
  Robotics: ['burger-flipping arm v4', 'drive-thru humanoid', 'self-cleaning fryer', 'robot barista franchise'],
  Biotech: ['longevity pill', 'gene-edited allergy cure', 'hangover vaccine', 'sleep-replacement enzyme'],
  Space: ['reusable cargo drone', 'orbital warehouse', 'moon parcel route', 'satellite-launch subscription'],
};

/** Growth/long-duration sectors react more to interest rates. */
export const RATE_DURATION: Record<string, number> = {
  Energy: 0.8,
  Quantum: 1.8,
  Social: 1.3,
  Robotics: 1.1,
  Biotech: 1.5,
  Space: 1.6,
};
