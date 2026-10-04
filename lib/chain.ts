/**
 * Chain definition.
 *
 * Inlined rather than imported from `viem/chains` on purpose: that barrel pulls in
 * every chain viem ships, which costs ~50s of transform time in this repo. We only
 * ever need Sepolia, and the object below is viem's own Sepolia definition.
 */
import { defineChain, type Chain } from 'viem'

export const SEPOLIA_CHAIN_ID = 11155111

/** ENS deploys at CREATE2-deterministic addresses, identical on mainnet and Sepolia. */
export const SEPOLIA_CHAIN = defineChain({
  id: SEPOLIA_CHAIN_ID,
  name: 'Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://ethereum-sepolia-rpc.publicnode.com'] },
  },
  blockExplorers: {
    default: { name: 'Etherscan', url: 'https://sepolia.etherscan.io' },
  },
  contracts: {
    multicall3: {
      address: '0xca11bde05977b3631167028862be2a173976ca11',
      blockCreated: 751532,
    },
    ensUniversalResolver: {
      address: '0xeeeeeeee14d718c2b47d9923deab1335e144eeee',
      blockCreated: 8928790,
    },
  },
  testnet: true,
})

export function isSepolia(chain: Chain | undefined): boolean {
  return chain?.id === SEPOLIA_CHAIN_ID
}