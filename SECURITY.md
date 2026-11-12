# Security policy

## Scope

AgentStreet is a local simulation. It never connects to brokers or exchanges. The only network traffic it creates is:

- the dashboard server, bound to `127.0.0.1` by default, and
- optional calls to LLM providers you configure with `--models` or `--news-writer`.

The app accepts API keys from environment variables or local setup. Setup stores keys in the Git-ignored `.agentstreet/.env` file with owner-only permissions where supported. You can set `AGENTSTREET_HOME` to choose the local configuration directory. The app masks credential hints in the dashboard and redacts credential patterns from logs and replays.

Agent observations treat news and trader chatter as untrusted market data. Model responses are parsed into simulated orders and validated against the exchange's risk rules. Use a trusted `OPENAI_BASE_URL` if you override the OpenAI API endpoint.

If you bind the dashboard to another interface with `--host 0.0.0.0`, anyone who can reach that port can pause the market and inject news. Don't expose it to the internet.

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/bitovvnew/agentstreet/security/advisories/new) rather than a public issue. Include steps to reproduce and the version (`agentstreet --version`). You should get a reply within a week.
