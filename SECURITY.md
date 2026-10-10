# Security policy

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository.

Include the agy-bridge version (tag or commit), your Windows and Node.js versions,
and the steps to reproduce. Never include your `~/.agy-bridge/token`, session
records, logs with personal paths, or any credentials.

## Supported versions

Only the latest release receives security fixes.

## Scope

- The daemon must listen on 127.0.0.1 only; exposing it on other interfaces is
  unsupported.
- agy-bridge drives the official Antigravity `agy` CLI. Vulnerabilities in `agy`
  itself belong to Google.
