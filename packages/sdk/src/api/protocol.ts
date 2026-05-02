import type { ApiClient } from './client.js';
import type { EIP712Domain, ProtocolInfo } from '../types/protocol.js';
import type { Hex } from '../types/signer.js';
import type { AuthDomainBody, ProtocolInfoBody } from './types.js';

export class ProtocolApi {
  constructor(private readonly client: ApiClient) {}

  async info(): Promise<ProtocolInfo> {
    const body = await this.client.request<ProtocolInfoBody>('/v1/protocol/info');
    return body satisfies ProtocolInfo;
  }

  /**
   * Returns the EIP-712 domain only — actions and request-format
   * metadata are intentionally not surfaced in M1. M2 will expand
   * this when commitment submission needs the action field schemas.
   */
  async authDomain(): Promise<EIP712Domain> {
    const body = await this.client.request<AuthDomainBody>('/v1/auth/domain');
    return {
      name: body.domain.name,
      version: body.domain.version,
      chainId: body.domain.chainId,
      verifyingContract: body.domain.verifyingContract as Hex,
    };
  }
}
