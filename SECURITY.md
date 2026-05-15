# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, use [GitHub's private vulnerability reporting](https://github.com/ospex-org/ospex-sdk/security/advisories/new) to report the issue privately. We'll triage and respond as soon as possible.

When reporting, please include:

- A clear description of the vulnerability and its impact
- Steps to reproduce, ideally with a minimal example
- The affected version (commit SHA or release tag)
- Any suggested mitigations

## Scope

This repository is the public SDK and CLI. In-scope concerns include (non-exhaustive):

- Anything that could leak a user's private key (keystore handling, session-cache behavior, error logging, transaction signing).
- Anything that could cause unintended on-chain spending (incorrect approval defaults, allowance preflight failures, signature reuse, nonce collisions).
- Misleading machine-contract output that an automated agent might act on (`--json` envelope shape correctness, typed error semantics, idempotency claims).
- Dependency vulnerabilities surfaced by the lockfile.

Smart-contract issues (the on-chain protocol itself) are out of scope here — please report those against the contracts repository.

## Wallet model

Ospex never asks for a raw private key in its public `Signer` interface. The recommended posture is a Foundry-managed keystore that the SDK reads via a passphrase prompt at signing time, or via a non-interactive `--password-file` for agent flows. The legacy `ospex wallet unlock` flow caches a decrypted private key in `~/.ospex/session` (mode `0600`, 15-minute TTL) — see [`docs/AGENT_CONTRACT.md` §8](./docs/AGENT_CONTRACT.md) for the full trust-boundary description and §4 for the non-interactive signing surface.

## Disclosure

We will coordinate disclosure timing with reporters. The default expectation is 90 days from acknowledgment to public disclosure, shorter if the issue is being actively exploited.
