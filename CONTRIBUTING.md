# Contributing

Thanks for helping improve UsageAtlas.

## Before opening a pull request

1. Install Bun 1.3.14 and Node.js 22.13 or newer.
2. Run `bun ci` from the repository root.
3. Keep the change focused and add tests for behavior changes.
4. Run `bun run lint`, `bun run typecheck`, and `bun run test`.

Use the existing workspace scripts to scope a command to one workspace, such as `bun run desktop:test` or
`bun run desktop:build`.

## Privacy and test data

Never commit credentials, provider responses copied from a real account, local databases, session files, or personal
file paths. Add sanitized fixtures for new provider behavior and keep network responses bounded and validated.

Report vulnerabilities using [SECURITY.md](SECURITY.md), not a public issue.

## Pull requests

Explain what changed, why it changed, and how you verified it. Screenshots are useful for visible interface changes.
Generated files should be updated with their owning tool rather than edited by hand.
