# @ospex/cli

Command-line interface for the [Ospex](https://ospex.org) protocol — zero-vig peer-to-peer sports prediction on Polygon. The `ospex` binary, built on top of [`@ospex/sdk`](https://github.com/ospex-org/ospex-sdk/tree/main/packages/sdk).

```sh
ospex init
ospex doctor
ospex contests list --hours 24
ospex commitments match 0xe900c6dd
```

## Install

This package ships as a **single self-contained bundle** via [GitHub Releases](https://github.com/ospex-org/ospex-sdk/releases), not npm. Everything (including `@ospex/sdk`) is bundled in, so you install one tarball globally and run bare `ospex` — nothing else to resolve:

```sh
npm install -g --allow-remote=root https://github.com/ospex-org/ospex-sdk/releases/download/v<ver>/ospex-cli-<ver>.tgz
# or: yarn global add https://github.com/ospex-org/ospex-sdk/releases/download/v<ver>/ospex-cli-<ver>.tgz
ospex --version
```

(`--allow-remote=root` is for npm 12+, which blocks remote-tarball installs by default; older npm ignores it with a warning. Yarn needs no flag.)

The separate `ospex-sdk-<ver>.tgz` library tarball is only for programmatic consumers importing `@ospex/sdk`; CLI users don't need it.

## Documentation

Full quickstart, command reference, wallet model, and the agent integration contract live in the [main repository](https://github.com/ospex-org/ospex-sdk):

- [README](https://github.com/ospex-org/ospex-sdk/blob/main/README.md)
- [Quickstart](https://github.com/ospex-org/ospex-sdk/blob/main/docs/QUICKSTART.md)
- [Agent integration contract](https://github.com/ospex-org/ospex-sdk/blob/main/docs/AGENT_CONTRACT.md)

## License

MIT — see [`LICENSE`](./LICENSE).
