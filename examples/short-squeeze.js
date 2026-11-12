// Example plugin: one custom strategy + one custom scenario.
//
//   agentstreet --plugin examples/short-squeeze.js --scenario short-squeeze
//
// A plugin is a plain ES module. Export personalities (strategies) and/or
// scenarios; AgentStreet registers anything it recognises. Prices are in cents.

/** A short seller who piles into the most "overvalued-looking" stock. */
const shortSeller = {
  id: 'short-seller',
  label: 'Activist Short Seller',
  description:
    'You are an activist short seller. You publish scathing research and short stocks that have run up too far, too fast. You cover only when the squeeze gets painful.',
  every: 5,
  research: true,
  startInvested: 0,
  capital: 40_000_000,
  traits: (rng) => ({ pain: rng.range(0.12, 0.25), size: rng.range(0.3, 0.6) }),
  strategy: ({ obs, mem, traits, rng }) => {
    const orders = [];
    for (const m of obs.markets) {
      if (m.halted || m.fairEstimate === null) continue;
      const pos = obs.positions[m.symbol] ?? 0;
      const rich = m.last / m.fairEstimate - 1;
      if (pos === 0 && rich > 0.12) {
        const qty = Math.floor((obs.buyingPower * traits.size) / m.last);
        if (qty > 0) {
          orders.push({ symbol: m.symbol, side: 'sell', type: 'market', qty });
          mem[m.symbol] = m.last;
          return { orders, thought: `${m.symbol} is ${Math.round(rich * 100)}% overvalued. Our short report drops tomorrow.` };
        }
      }
      if (pos < 0 && mem[m.symbol] && m.last / mem[m.symbol] - 1 > traits.pain) {
        orders.push({ symbol: m.symbol, side: 'buy', type: 'market', qty: -pos });
        return { orders, thought: rng.pick([`Covering ${m.symbol}. The squeeze is real.`, `Uncle. Out of the ${m.symbol} short.`]) };
      }
    }
    return { orders };
  },
};

/** MEOW goes viral while shorts pile in, then a buyout rumor turns out to be true. */
const shortSqueeze = {
  id: 'short-squeeze',
  name: 'Short Squeeze',
  description: 'Shorts pile into a meme-y CatNet Media (MEOW). Then retail finds out, and a buyout rumor lands.',
  config: {
    mix: { 'market-maker': 4, value: 6, momentum: 8, panic: 6, rumor: 8, contrarian: 4, retail: 40, degen: 8, 'short-seller': 6 },
  },
  onTick(sim, t) {
    if (t === 30 || t === 60) sim.apply({ type: 'pump', symbol: 'MEOW' });
    if (t === 150) sim.apply({ type: 'news', symbol: 'MEOW', tone: 'positive', kind: 'rumor' });
    if (t === 180 || t === 200) sim.apply({ type: 'pump', symbol: 'MEOW' });
    if (t === 230) sim.apply({ type: 'news', symbol: 'MEOW', tone: 'positive', kind: 'earnings', headline: 'CatNet Media posts first-ever profit; short sellers scramble' });
  },
};

export default { personalities: [shortSeller], scenarios: [shortSqueeze] };
