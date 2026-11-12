import type { Rng } from '../core/rng.js';

const ADJ = [
  'Silent', 'Bullish', 'Bearish', 'Lucky', 'Quantum', 'Diamond', 'Paper', 'Turbo', 'Sleepy', 'Greedy', 'Nervous', 'Stoic',
  'Rogue', 'Golden', 'Crypto', 'Velvet', 'Iron', 'Neon', 'Shadow', 'Cosmic', 'Feral', 'Polite', 'Chaotic', 'Lazy',
  'Hyper', 'Moody', 'Frugal', 'Reckless', 'Zen', 'Spicy', 'Cautious', 'Wild',
];
const NOUN = [
  'Otter', 'Llama', 'Falcon', 'Badger', 'Panda', 'Walrus', 'Mantis', 'Gecko', 'Moose', 'Raven', 'Hamster', 'Shark',
  'Koala', 'Lynx', 'Yak', 'Heron', 'Bison', 'Ferret', 'Narwhal', 'Puffin', 'Tapir', 'Wombat', 'Jackal', 'Orca',
  'Pigeon', 'Mongoose', 'Axolotl', 'Capybara', 'Lemur', 'Ibex', 'Marmot', 'Quokka',
];

/** Unique, deterministic trader handles like "@SilentOtter". */
export function makeNames(rng: Rng, n: number): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  while (out.length < n) {
    let name = `${rng.pick(ADJ)}${rng.pick(NOUN)}`;
    if (used.has(name)) name = `${name}${rng.int(2, 99)}`;
    if (used.has(name)) continue;
    used.add(name);
    out.push(name);
  }
  return out;
}
