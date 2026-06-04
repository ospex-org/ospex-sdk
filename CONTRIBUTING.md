# Contributing

Thanks for your interest in `@ospex/sdk` + `@ospex/cli`.

This is a focused public SDK for the Ospex protocol. Drive-by stylistic changes are unlikely to be merged; substantive bug fixes and additions that align with the project's surface (see [`README.md`](./README.md) for what's currently supported) are welcome.

## Before you start

- For a non-trivial change, please [open an issue](https://github.com/ospex-org/ospex-sdk/issues/new) describing what you want to do and why. A short conversation up front saves rework.
- For trivial fixes (typos, broken links, doc clarifications), a PR directly to `main` is fine.
- Security issues — see [`SECURITY.md`](./SECURITY.md). Do not open public issues for those.

## Development workflow

```sh
yarn install --frozen-lockfile
yarn workspace @ospex/sdk build       # SDK must build before CLI typechecks
yarn typecheck
yarn test
```

Run the full sequence before pushing. CI runs the same on every PR.

The integration playbook at [`docs/MANUAL_INTEGRATION_TESTING.md`](./docs/MANUAL_INTEGRATION_TESTING.md) is the manual smoke test against a live testnet. You don't need to walk it for routine changes, but we walk it before tagging a release.

## Commit messages

Conventional-commits style:

- `feat(sdk,cli): new x`
- `fix(sdk): broken y`
- `docs: clarify z`
- `chore: bump deps`

Keep the subject line short; put detail in the body if needed.

## Pull requests

- Branch from `main`. Branch naming: `feature/`, `fix/`, `docs/`, `chore/`.
- Keep PRs focused — one concern per PR makes review faster.
- Update the [`CHANGELOG.md`](./CHANGELOG.md) `Unreleased` section if your change is user-visible.
- Update the [`docs/AGENT_CONTRACT.md`](./docs/AGENT_CONTRACT.md) and/or [`docs/AGENT_ENVELOPE_SPEC.md`](./docs/AGENT_ENVELOPE_SPEC.md) only if you're changing the stable agent surface (JSON envelopes, typed error codes, idempotency, etc.). Schema changes inside `schemaVersion: 2` must be additive.
- **Docs and JSDoc are part of the published surface.** Exported-type JSDoc compiles into `dist/types/*.d.ts`, and the CLI's `.option(...)` help strings and next-command templates are user-facing text. When you rename or deprecate a public name, grep the whole surface — `**/*.md` (README / CHANGELOG / SECURITY / `docs/*.md`) **and** `packages/**/*.ts` (exported-type JSDoc, CLI help, command templates) — not just the code paths. A stale reference left in a JSDoc comment or help string ships to users in the next release.

## License

By contributing, you agree that your contributions will be licensed under the same MIT License that covers the rest of the project (see [`LICENSE`](./LICENSE)).
