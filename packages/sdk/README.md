# @ospex/sdk

TypeScript SDK for the [Ospex](https://ospex.org) protocol — zero-vig peer-to-peer sports prediction on Polygon. Reads (contests, speculations, commitments, positions, leaderboard, odds), EIP-712 signed-commitment submission/match/cancel, position settlement and claims, and contest creation. Realtime odds via Supabase channels.

```ts
import { OspexClient } from '@ospex/sdk';

const client = new OspexClient();
const contests = await client.contests.list({ sport: 'nba', hours: 24 });
```

The optional keystore signer is shipped as a subpath import so consumers who don't need it don't pull `ethers` into their bundle:

```ts
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';
```

## Distribution

This package ships via [GitHub Releases](https://github.com/ospex-org/ospex-sdk/releases), not npm. Download `ospex-sdk-<ver>.tgz` from the latest release and:

```sh
yarn add file:./ospex-sdk-<ver>.tgz
```

## Documentation

Full quickstart, command reference, configuration, and the agent integration contract live in the [main repository](https://github.com/ospex-org/ospex-sdk):

- [README](https://github.com/ospex-org/ospex-sdk/blob/main/README.md)
- [Quickstart](https://github.com/ospex-org/ospex-sdk/blob/main/docs/QUICKSTART.md)
- [Agent integration contract](https://github.com/ospex-org/ospex-sdk/blob/main/docs/AGENT_CONTRACT.md)

## License

MIT — see [`LICENSE`](./LICENSE).
