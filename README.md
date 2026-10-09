# SoroBunker

A minimal vault for Stellar that uses hashed one-time keys to stay quantum-resistant at rest.

Live demo on testnet: https://tomerweller.com/sorobunker/

> [!WARNING]
> Experimental and unaudited. Testnet only. Do not use with real funds.

## How it works

- The vault stores only `sha256(ed25519 public key)`, never the public key itself.
- To transfer, the key holder signs a human-readable message describing the transfer and
  reveals the public key. The contract checks the key against the stored hash and verifies
  the signature.
- Every transfer also commits to the hash of the next key, so each key is revealed and
  used exactly once.
- Anyone can submit a signed transfer and pay its fees; they cannot change the recipient,
  amount, token or next key, which are all signed.

### Security model: quantum-resistant at rest

While a key is unused, the only thing on-chain is its hash, which a quantum computer cannot
reverse (SHA-256 keeps about 128-bit security against Grover's algorithm). That protects a
vault that sits idle from a future attacker who can break elliptic-curve keys.

It is not fully post-quantum: once a transfer is broadcast, its public key is exposed
until the transaction lands and the key rotates. An attacker who could derive the secret key
within that window (about one ledger) could sign a different transfer.

## Repository layout

| Path | What it is |
|---|---|
| [`contracts/sorobunker`](contracts/sorobunker) | The Soroban contract and its tests |
| [`client`](client) | Rust library and `sorobunker` CLI: key derivation, signing, the signed message |
| [`web`](web) | Vite + TypeScript web app that uses [Freighter](https://www.freighter.app) accounts as vault keys |

## Web app

The web app runs on testnet and uses Freighter for every key. It keeps three kinds of account apart:

| Role | What it does | Account |
|---|---|---|
| Fee payer | Signs and pays for transactions | Any funded account. Never a vault key. |
| Current vault key | Signs the transfer message ([SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md)) | The Freighter account whose public key hashes to the vault's stored hash |
| Next vault key | Nothing yet; only its hash goes on-chain | A new, never-funded Freighter account |

To use it, set Freighter to **Testnet**, then:

1. Connect Freighter, select a funded account and make it the fee payer.
2. Add a new account in Freighter (name it e.g. *SoroBunker key 1 (do not fund)*), select it
   and click *Create vault*.
3. Deposit some XLM from the fee payer.
4. To send, enter the recipient and amount. When asked for the next key, add another new
   account in Freighter and select it; the app checks it and offers to use it. Review the
   message, then click *Sign with key #n*. Freighter asks the current key to sign the message,
   then the fee payer to sign the transaction.

The dashboard shows the vault's balance, which account holds each role (fee payer, current
key, next key), the chain of revealed keys, and what this browser has done with the vault.

Before submitting, the app verifies the wallet's signature locally and simulates the call,
so a bad signature or a failing transfer is caught before the key is revealed on-chain.

Freighter cannot create accounts for an app, so each new key is added by hand, one per
transfer. They are all derived from your Freighter recovery phrase. The app remembers which
account is each vault's current key in this browser; if that is lost, select the right
account in Freighter and use it as the current key from the dashboard (the app checks its hash).

> [!IMPORTANT]
> Never fund or share a vault key's address. In Stellar, an account address *is* its public
> key, so funding it puts the key on-chain.

## Contract

```rust
fn __constructor(env, pk_hash: BytesN<32>);
fn transfer_rotate(env, token: Address, to: Address, amount: i128, next_pk_hash: BytesN<32>,
                   pubkey: BytesN<32>, sig: BytesN<64>) -> Result<(), Error>;
fn extend_ttl(env);          // anyone may keep the vault alive
fn pk_hash(env) -> BytesN<32>;
fn nonce(env) -> u64;
fn is_key_used(env, pk_hash: BytesN<32>) -> bool;  // already revealed by this vault?
```

- Deposit by sending any SEP-41 token (or Stellar Asset Contract) to the vault's address.
- `transfer_rotate` checks `sha256(pubkey) == pk_hash`, verifies `sig` over the message
  below, marks the current key as used, stores `next_pk_hash`, increments the nonce, then
  calls the token's `transfer`, which validates the amount. To rotate without moving funds,
  transfer 0 XLM.
- The vault keeps each revealed key hash in persistent storage (the used-key registry), and
  `next_pk_hash` is rejected if it is the current key or any key the vault has revealed. The
  web app checks `is_key_used` before choosing a next key, so this holds even if the browser
  forgets which keys it used. The registry is per vault.
- The error codes are `WrongPublicKey = 1` and `KeyReuse = 2` (the next key is the current
  key or was already used). An invalid signature traps in the host's `ed25519_verify`
  instead of returning a contract error.
- Every successful call emits `transfer_rotate` with topics `(token, to)` and data
  `{nonce, amount, next_pk_hash}`.

### Signed message

The contract builds this message itself, and the key signs it as a SEP-53 message:
`sha256("Stellar Signed Message:\n" || message)`. A wallet shows it as-is, so the user can
check the recipient and amount before signing.

```text
SoroBunker transfer_rotate
vault: CD5WS6EMV4GBZDVIBKJVO4RSQPFFKSAS5OQCQFJT7A2NV27KSDZDYKX6
nonce: 7
token: CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
to: GBYUK7JWE4DX3Y2YR6TM755BVUVEVL4723TQ2SSUHH7YURGYRFNVSTLO
amount: 250000000
next key hash: 4544cd0c4d74d6a730377c69f69d4f8fe58e3043bbe8aeedd4d84db8fac753fd
```

Lines are separated by `\n` with no trailing newline. Addresses are strkeys, `amount` is in
the token's base units, and the hash is lowercase hex. The vault address prevents replay on
other vaults and networks (a contract address already commits to its network); the nonce
and key rotation prevent replay on this one. The contract, the Rust client and the web app
share a test vector for this format.

## CLI

The `sorobunker` CLI manages a vault from a single seed file instead of a wallet. Key `n`
signs the vault's transfer at nonce `n`:

- `sk_n = sha256("SOROBUNKER_ED25519_SK_V1" || seed || n_be64)` (the ed25519 secret key)
- `pk_hash_n = sha256(ed25519_public_key(sk_n))`

```bash
cargo build --release -p sorobunker-client   # builds target/release/sorobunker
stellar contract build

# Create a key and deploy a vault
PK0=$(./target/release/sorobunker keygen --seed-file vault.seed)
stellar contract deploy --wasm target/wasm32v1-none/release/sorobunker.wasm \
  --source deployer --network testnet -- --pk_hash $PK0

# Transfer (and rotate)
NONCE=$(stellar contract invoke --id $VAULT --source relayer --network testnet -- nonce)
./target/release/sorobunker sign --seed-file vault.seed \
  --contract $VAULT --nonce $NONCE --token $TOKEN --to $TO --amount 100 > tx.json
stellar contract invoke --id $VAULT --source relayer --network testnet -- transfer_rotate \
  --token $TOKEN --to $TO --amount 100 --next_pk_hash $(jq -r .next_pk_hash tx.json) \
  --pubkey $(jq -r .pubkey tx.json) --sig $(jq -r .sig tx.json)
```

Back up the seed file and use one seed per vault. A vault can move between CLI keys and
wallet keys with a zero-amount transfer whose next key comes from the other.

## Development

Requires Rust (the version is pinned in `rust-toolchain.toml`), the
[Stellar CLI](https://developers.stellar.org/docs/tools/cli) v25.2+ and Node.js 22+.

```bash
stellar contract build   # contract wasm
cargo test               # contract and client tests (including a cost test on the wasm)

cd web
npm install
npm run dev              # http://localhost:5173
npm test                 # message format and SEP-53 checks
npm run e2e              # full flow on testnet, with in-memory keys in place of Freighter
```

`web/qa/fake-freighter.js` stands in for the Freighter extension during QA: injected into the
page, it answers Freighter's message protocol with real testnet keys, logs what the app asks
the wallet to sign, and can simulate declines, a wrong network or a misbehaving wallet. See
the comment at the top of the file for how to inject and drive it.

## License

[Apache-2.0](LICENSE)
