/**
 * ENS contract addresses and the minimal ABIs we need.
 *
 * Every address below was verified live against Sepolia (`eth_getCode` returns
 * non-empty bytecode) while building this. ENS deploys these at
 * CREATE2-deterministic addresses, so they are identical on mainnet and Sepolia;
 * the `verifiedSepoliaBytecodeSize` field records the bytecode size we saw.
 *
 * References:
 *   https://docs.ens.domains/learn/deployments#sepolia
 *   https://github.com/ensdomains/ens-contracts/tree/master/deployments
 */

import type { Abi } from 'viem'

export const ENS_ADDRESSES = {
  /** ENS Registry — owner(node), resolver(node), setSubnodeOwner(node, ...). */
  registry: {
    address: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
    verifiedSepoliaBytecodeSize: 3174,
  },
  /** NameWrapper — creates subnames under a parent you own. */
  nameWrapper: {
    address: '0x0635513f179D50A207757E05759CbD106d7dFcE8',
    verifiedSepoliaBytecodeSize: 24311,
  },
  /**
   * Public Resolver — where the profile text records live.
   *
   * This deployment is NameWrapper-aware: its authorisation check resolves
   * `ens.owner(node) == nameWrapper` down to `nameWrapper.ownerOf(node)`, which
   * is what lets a plain EOA (the wrapper's NFT owner) call `setText` on a
   * wrapped subname directly, without deploying a registrar contract.
   */
  publicResolver: {
    address: '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5',
    verifiedSepoliaBytecodeSize: 14512,
  },
  /**
   * Fallback resolver used by names registered before the Sepolia redeploy.
   * Also NameWrapper-aware. The seed script sticks to `publicResolver`, but the
   * verifier reports whichever resolver a name actually points at.
   */
  legacyPublicResolver: {
    address: '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD',
    verifiedSepoliaBytecodeSize: 12336,
  },
  /** Universal Resolver — what viem's `getEnsText` calls under the hood. */
  universalResolver: {
    address: '0xeeeeeeee14d718c2b47d9923deab1335e144eeee',
    verifiedSepoliaBytecodeSize: 2491,
  },
} as const

export type EnsContractName = keyof typeof ENS_ADDRESSES

export const ensRegistryAbi = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'resolver',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'ttl',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'recordExists',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'setSubnodeOwner',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'label', type: 'bytes32' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setResolver',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setOwner',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [],
  },
] as const satisfies Abi

export const nameWrapperAbi = [
  {
    type: 'function',
    name: 'setSubnodeRecord',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'label', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'resolver', type: 'address' },
      { name: 'ttl', type: 'uint64' },
      { name: 'fuses', type: 'uint32' },
      { name: 'expiry', type: 'uint64' },
    ],
    outputs: [{ name: 'node', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'setSubnodeOwner',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'label', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'fuses', type: 'uint32' },
      { name: 'expiry', type: 'uint64' },
    ],
    outputs: [{ name: 'node', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getData',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'fuses', type: 'uint32' },
      { name: 'expiry', type: 'uint64' },
    ],
  },
  {
    type: 'function',
    name: 'isWrapped',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'canModifyName',
    stateMutability: 'view',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'addr', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi

export const resolverAbi = [
  {
    type: 'function',
    name: 'text',
    stateMutability: 'view',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
    ],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'setText',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setAddr',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'a', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
] as const satisfies Abi

/** Fuse bit: once burned, the parent can never replace or delete the name. */
export const PARENT_CANNOT_CONTROL = 1 << 0
/** Fuse bit: the name can never be unwrapped. Required to burn owner fuses. */
export const CANNOT_UNWRAP = 1 << 1
/** Fuse bit: no new subnames may be created under this name. */
export const CANNOT_CREATE_SUBDOMAIN = 1 << 10

/** `0x000...000` — the "no resolver / no owner" sentinel. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

export const FUSE_NAMES: Readonly<Record<number, string>> = {
  [PARENT_CANNOT_CONTROL]: 'PARENT_CANNOT_CONTROL',
  [CANNOT_UNWRAP]: 'CANNOT_UNWRAP',
  [CANNOT_CREATE_SUBDOMAIN]: 'CANNOT_CREATE_SUBDOMAIN',
}

export function describeFuses(fuses: number): string {
  const names = Object.entries(FUSE_NAMES)
    .filter(([bit]) => (fuses & Number(bit)) !== 0)
    .map(([, name]) => name)
  return names.length > 0 ? names.join(' | ') : 'none burned'
}