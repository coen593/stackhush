# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's private
vulnerability reporting: on https://github.com/coen593/stackhush go to Security, then "Report a
vulnerability" (a private security advisory). Include what you found, how to reproduce it and what
an attacker could do with it.

You will get a reply as soon as the maintainer can, normally within a few days. Please give a
reasonable time to fix the problem before you disclose it.

## Scope

stackhush is one owner's dashboard. The parts that matter most: the sign-in flow and sessions, the
rule that every `/api/*` route except sign-in needs a session, anything that could put private
data (project names, URLs, tokens) into the public static bundle, and the alert email path.

Out of scope: problems in your own Cloudflare, GitHub or Supabase account settings, and tokens you
created with more permissions than [docs/setup.md](docs/setup.md) lists.

## Supported versions

Only the latest release is supported.
