import {
  OspexAllowanceError,
  getAddresses,
  type ChainId,
  type PreviewApproval,
} from '@ospex/sdk';

/**
 * Fail closed when an execute-path preview would enter the CLI's approval loop.
 * Automated callers that ledger approvals separately use this immediately after
 * the execute preview and before any preflight auth, approval, commitment
 * signature, transaction, or POST.
 */
export function refuseRequiredAutoApproval(
  approvals: readonly PreviewApproval[],
  noAutoApprove: boolean,
  chainId: ChainId,
  action: 'commitments match' | 'commitments submit',
): void {
  if (!noAutoApprove) return;
  const required = approvals.find((row) => row.token === 'USDC' && row.needsApproval);
  if (required === undefined) return;

  throw new OspexAllowanceError(
    `${action} requires a USDC approval, but --no-auto-approve forbids implicit approval. ` +
      'Run the explicit approval command and retry.',
    {
      required: BigInt(required.required),
      current: BigInt(required.current),
      spender: required.spender,
      token: getAddresses(chainId).usdc,
    },
  );
}
