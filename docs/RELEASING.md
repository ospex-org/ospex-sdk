# Releasing

Runbook for cutting a new `@ospex/sdk` + `@ospex/cli` release. Both packages version in lockstep — they're tagged together and ship as a paired tarball download.

## Cadence

Releases are cut on demand, not on a schedule. Trigger conditions:

- Substantive new SDK / CLI surface area.
- Any change to the stable agent contract (`docs/AGENT_CONTRACT.md` / `docs/AGENT_ENVELOPE_SPEC.md`) — even additive ones that don't break `schemaVersion: 2` get a release so consumers can pin to a known version.
- Security fixes — out-of-band, prioritized.

## Pre-release checklist

1. **All PRs for the release are merged into `main`.**
2. **`main` is clean:** `git status` shows no uncommitted changes; `git diff --check` is clean.
3. **CI is green** on the latest `main` commit.
4. **Walk the manual integration playbook** at [`docs/MANUAL_INTEGRATION_TESTING.md`](./MANUAL_INTEGRATION_TESTING.md), to the extent the current testbed allows. Read-side and signer sections (1, 2, 2.5, 3, 7) run against production. The on-chain sections (4, 5, 6, 6.5, 9 Case B, 10) require a seeded contest on the target network — today that means **mainnet only**: Amoy's `OracleModule` script approvals aren't signed and committed to `ospex-core-api`, so `contests create` doesn't work there and no contests are seeded. Under the current pre-1.0, 0-user posture, a hard gate on Section 5 is unenforceable; the working substitute is that regressions in the on-chain surface surface through operator self-use, and a release is reverted (yanked via patch release per the "If something goes wrong" section below) rather than blocked. Document any deferred section in the release ticket — and revisit this clause once Amoy is seeded (see [Amoy script-approval limitation in `MANUAL_INTEGRATION_TESTING.md`](./MANUAL_INTEGRATION_TESTING.md#prereqs-one-time)).
5. **Update [`CHANGELOG.md`](../CHANGELOG.md)**: move the `Unreleased` items into a new dated section with the upcoming version; reset `Unreleased` to `—`.
6. **Bump versions in lockstep:**
   - `package.json` (workspace root)
   - `packages/sdk/package.json`
   - `packages/cli/package.json`
   - The CLI tarball install snippet in `docs/QUICKSTART.md` if it pins by version.
7. Open a release PR with the version bump + CHANGELOG, get it reviewed, merge.

## Build the release tarballs

From a clean checkout of the merged release commit:

```sh
git checkout main
git pull origin main
yarn install --frozen-lockfile
yarn workspace @ospex/sdk clean
yarn workspace @ospex/cli clean
yarn workspace @ospex/sdk build
yarn workspace @ospex/cli build
yarn workspace @ospex/sdk pack --filename ospex-sdk-<ver>.tgz
yarn workspace @ospex/cli pack --filename ospex-cli-<ver>.tgz
```

The two tarballs land at:

- `packages/sdk/ospex-sdk-<ver>.tgz`
- `packages/cli/ospex-cli-<ver>.tgz`

Smoke-test from a fresh working directory. Copy the two tarballs out
of the repo first so the install command stays short and avoids any
absolute-path quoting quirks (notably with yarn 1 on Windows / Git
Bash, where `file:` URLs misparse):

```sh
mkdir /tmp/ospex-release-smoke && cd /tmp/ospex-release-smoke
cp /path/to/ospex-sdk/packages/sdk/ospex-sdk-<ver>.tgz .
cp /path/to/ospex-sdk/packages/cli/ospex-cli-<ver>.tgz .
yarn init -y
yarn add ./ospex-sdk-<ver>.tgz ./ospex-cli-<ver>.tgz
npx ospex --version
npx ospex health
```

## Tag and push

```sh
git tag -a v<ver> -m "v<ver>"
git push origin v<ver>
```

## Cut the GitHub Release

1. Open <https://github.com/ospex-org/ospex-sdk/releases/new>.
2. Choose the tag you just pushed.
3. Title: `v<ver>`.
4. Body: paste the corresponding section from `CHANGELOG.md`. Add any operator notes (known issues, migration guidance) that don't belong in the changelog itself.
5. Attach both tarballs (`ospex-sdk-<ver>.tgz`, `ospex-cli-<ver>.tgz`) as release assets.
6. Mark as the latest release.
7. Publish.

## Post-release

- Verify the tarball download links resolve from a logged-out browser.
- Update any external pointers (e.g., the [ospex.org](https://ospex.org) downloads page) to the new version or the `/releases/latest` URL.
- Announce as appropriate.

## If something goes wrong

If a release ships with a critical bug:

1. **Do not delete the tag** unless within minutes of pushing. Yank-by-deletion is hostile to consumers who already pulled.
2. Cut a patch release (`v<ver>.<patch+1>`) with the fix following this same runbook.
3. Edit the broken release notes on GitHub to add a prominent **deprecated — use v<ver+1>** banner at the top.
