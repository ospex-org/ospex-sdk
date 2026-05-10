# @ospex/cli

Command-line interface for the [Ospex](https://ospex.org) protocol — zero-vig peer-to-peer sports prediction on Polygon. The `ospex` binary, built on top of [`@ospex/sdk`](https://github.com/ospex-org/ospex-sdk/tree/main/packages/sdk).

```sh
ospex init
ospex doctor
ospex contests list --hours 24
ospex commitments match 0xe900c6dd
```

## Distribution

This package ships via [GitHub Releases](https://github.com/ospex-org/ospex-sdk/releases), not npm. Download both `ospex-sdk-<ver>.tgz` and `ospex-cli-<ver>.tgz` from the latest release and install in the same `yarn add` call:

```sh
yarn add file:./ospex-sdk-<ver>.tgz file:./ospex-cli-<ver>.tgz
```

The CLI uses the SDK at runtime but does not declare it as a regular dependency — yarn 1's `file:` resolver would treat the SDK reference as an npm registry lookup and fail. Always install both tarballs together.

## Documentation

Full quickstart, command reference, wallet model, and the agent integration contract live in the [main repository](https://github.com/ospex-org/ospex-sdk):

- [README](https://github.com/ospex-org/ospex-sdk/blob/main/README.md)
- [Quickstart](https://github.com/ospex-org/ospex-sdk/blob/main/docs/QUICKSTART.md)
- [Agent integration contract](https://github.com/ospex-org/ospex-sdk/blob/main/docs/AGENT_CONTRACT.md)

## License

MIT — see [`LICENSE`](./LICENSE).
