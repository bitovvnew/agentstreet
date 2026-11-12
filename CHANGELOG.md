# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-11-12

First public release.

### Exchange
- Price-time-priority limit order book per symbol with integer-cent prices.
- Market, limit and IOC orders; cancels; self-trade prevention (cancel resting).
- Taker fees and maker rebates.
- Portfolio margin with short selling (~3x gross exposure), maintenance margin, forced liquidation and bankruptcy.
- Limit-up / limit-down bands with 15-minute single-stock halts and a re-opening cross.
- Market-wide circuit breakers at −7%, −13% and −20%.
- Interest on cash, margin-loan interest and short borrow fees.

### Agents
- Eight heuristic personalities: market maker, value investor, momentum chaser, panic seller, rumor chaser, contrarian, retail crowd, leveraged degen.
- LLM brains for OpenAI (and compatible APIs), Anthropic, Google Gemini and Ollama, with response validation, clamping and heuristic fallback.
- Model league: each `--models` entry fields a five-trader team with equal capital.

### Market
- Six fictional companies with hidden fundamental values, interest-rate sensitivity by sector.
- Newsroom with earnings, products, lawsuits, scandals, analyst calls, macro prints, social hype and rumors that resolve as confirmed or denied; optional LLM headline writer.
- Scenarios: `default`, `meme-mania`, `flash-crash`, `rate-shock`, `earnings-season`.
- Plugin API for custom strategies and scenarios (`--plugin`).

### Terminal
- Bloomberg-style live dashboard: watchlist, candlesticks with true-value overlay, order book ladder, depth chart, Fear & Greed gauge, market stats, time & sales, leaderboard with equity curves, newswire, agent chatter, alert log.
- Control room: inject news or your own headline, rumors, meme pumps, fat-finger crashes, halts, rate moves.
- Time travel over the whole session, replay mode, deep links (`?t=&sym=&tf=&lb=&feed=`), color-blind palette toggle, responsive down to phones.

### Replays
- Deterministic seeds; recorded inputs and LLM decisions; `run`, `replay` and `verify` commands; gzip support.

[0.1.0]: https://github.com/bitovvnew/agentstreet/releases/tag/v0.1.0
