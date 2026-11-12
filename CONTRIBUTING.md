# Contributing to AgentStreet

Thanks for wanting to make the fake market more chaotic. Contributions of every size are welcome: a new trader personality, a scenario, a dashboard panel, a bug fix or a typo.

## Setup

```bash
git clone https://github.com/bitovvnew/agentstreet && cd agentstreet
npm install          # also builds dist/
npm test             # vitest
npm start            # build + live demo at http://127.0.0.1:4600
```

Node 20 or newer. There are no runtime dependencies; please keep it that way unless there is a very good reason.

## Where things live

| Area | Path |
|---|---|
| Matching engine, margin, breakers | `src/engine/` |
| Newsroom | `src/news/newsroom.ts` |
| Strategies (personalities) | `src/agents/personalities.ts` |
| LLM adapters and prompt | `src/agents/brains/` |
| Tick loop, fundamentals, recorder | `src/sim/` |
| Scenarios | `src/scenarios/index.ts` |
| Dashboard (no build step) | `dashboard/` |

## Ground rules

1. **Determinism is sacred.** Never use `Math.random()`, `Date.now()` or wall-clock time inside the simulation. Use the `Rng` you are given (`ctx.rng`, `sim.rng.fork('label')`). `npm test` includes replay-hash checks that will catch you.
2. **Money is cents, shares are integers.** Inside the engine prices are integer cents.
3. **Keep it fictional.** No real tickers, companies, people or brokers. No code that could place real orders.
4. **Engine changes need tests.** Add a case to `test/exchange.test.ts` or `test/simulation.test.ts`.
5. **Screenshots come from demo data only.** Run `npm run screenshots` (needs Chrome or Edge) instead of capturing your own screen.

## Adding a strategy

The fastest path is a plugin (see `examples/short-squeeze.js`). If it is broadly fun, open a PR adding it to `src/agents/personalities.ts` with:

- an `id`, a `label` and a `description` written in second person (it doubles as the LLM system prompt),
- a `strategy` that returns `{ orders, cancel?, thought? }`,
- sensible `capital`, `every` and `startInvested` values,
- a line in the README table.

## Pull requests

- Keep PRs focused; describe what changed and how you checked it.
- `npm run typecheck && npm test` must pass.
- For dashboard changes, attach a screenshot from `npm run screenshots` or a demo run.

## Reporting bugs

Open an issue with steps to reproduce. If the bug is in the market itself, attach a replay file (the **⤓ Replay** button, or `agentstreet run --out`): a seed plus recorded inputs reproduces the exact session.
