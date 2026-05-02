import { OspexValidationError } from '../errors.js';
import type { ApiClient } from './client.js';
import type { Position, PositionStatus } from '../types/position.js';
import type { PositionBody, PositionStatusBody, PositionsByAddressBody } from './types.js';

export class PositionsApi {
  constructor(private readonly client: ApiClient) {}

  async byAddress(address: string): Promise<Position[]> {
    const normalized = ensureAddress(address);
    const body = await this.client.request<PositionsByAddressBody>(
      `/v1/positions/${encodeURIComponent(normalized)}`,
    );
    return body.positions.map(toPosition);
  }

  async status(address: string): Promise<PositionStatus> {
    const normalized = ensureAddress(address);
    const body = await this.client.request<PositionStatusBody>(
      `/v1/positions/${encodeURIComponent(normalized)}/status`,
    );
    return {
      active: body.active,
      claimable: body.claimable,
      totals: body.totals,
    };
  }
}

function toPosition(body: PositionBody): Position {
  return body satisfies Position;
}

function ensureAddress(address: string): string {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new OspexValidationError('Invalid Ethereum address', { field: 'address' });
  }
  return address.toLowerCase();
}
