// Minimal stand-in for @xyo-network/xl1-sdk.
//
// server.mjs uses exactly three names from the SDK, and none of them are
// exercised by the decisions under test — those all operate on data the
// collector wrote or the chain poller already stored. Installing 100 MB of
// real SDK to test a version comparison would make the suite something people
// skip, which is the same as not having one.
export const DefaultNetworks = [
  { id: 'sequence', name: 'Sequence', chain: '4b43a753c8024c0e5000e8ac948ac0063ac624bc', url: 'https://example.invalid' },
  { id: 'mainnet', name: 'Mainnet', chain: '0000000000000000000000000000000000000000', url: 'https://example.invalid' },
]
export const NetworkDataLakeUrls = { sequence: 'https://example.invalid', mainnet: 'https://example.invalid' }
export class GatewayBuilder {
  name() { return this }
  rpcUrl() { return this }
  dataLakeEndpoint() { return this }
  build() { return { connection: { viewer: null } } }
}
