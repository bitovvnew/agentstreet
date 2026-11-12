# Security policy

## Scope

AgentStreet is a local simulation. It never connects to brokers or exchanges. The only network traffic it creates is:

- the dashboard server, bound to `127.0.0.1` by default, and
- optional calls to LLM providers you configure with `--models` or `--news-writer`.

API keys are read from environment variables, sent only to the provider they belong to, and never written to logs or replay files.

If you bind the dashboard to another interface with `--host 0.0.0.0`, anyone who can reach that port can pause the market and inject news. Don't expose it to the internet.

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/bitovvnew/agentstreet/security/advisories/new) rather than a public issue. Include steps to reproduce and the version (`agentstreet --version`). You should get a reply within a week.
