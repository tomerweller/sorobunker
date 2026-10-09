//! SoroBunker: a minimal vault guarded by a hashed, rotating ed25519 key.
//!
//! The vault stores only `sha256(ed25519_public_key)`, so the public key stays hidden
//! (and out of reach of a quantum attacker) until it is used. Every transfer reveals the
//! current public key with a signature over the transfer, and commits to the hash of
//! the next key, so each key is revealed and used exactly once.
//!
//! This is quantum-resistant at rest only: once a transfer is broadcast, the revealed
//! public key is exposed until the transaction lands and the key rotates.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Bytes,
    BytesN, Env,
};

/// SEP-53 ("Sign and Verify Messages") prefix.
pub const SEP53_PREFIX: &[u8] = b"Stellar Signed Message:\n";

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 120 * DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    PkHash,
    Nonce,
}

/// An invalid ed25519 signature is not listed here: `ed25519_verify` traps the call.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    WrongPublicKey = 1,
    KeyReuse = 2,
}

/// Emitted on every successful `transfer_rotate`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferRotate {
    #[topic]
    pub token: Address,
    #[topic]
    pub to: Address,
    pub nonce: u64,
    pub amount: i128,
    pub next_pk_hash: BytesN<32>,
}

#[contract]
pub struct SoroBunker;

#[contractimpl]
impl SoroBunker {
    pub fn __constructor(env: Env, pk_hash: BytesN<32>) {
        env.storage().instance().set(&DataKey::PkHash, &pk_hash);
        env.storage().instance().set(&DataKey::Nonce, &0u64);
        extend_instance_ttl(&env);
    }

    /// Send `amount` of `token` to `to`, authorized by the current key `pubkey` signing
    /// [`transfer_rotate_message`] as a SEP-53 message, and rotate to `next_pk_hash`.
    pub fn transfer_rotate(
        env: Env,
        token: Address,
        to: Address,
        amount: i128,
        next_pk_hash: BytesN<32>,
        pubkey: BytesN<32>,
        sig: BytesN<64>,
    ) -> Result<(), Error> {
        let pk_hash = Self::pk_hash(env.clone());
        if next_pk_hash == pk_hash {
            return Err(Error::KeyReuse);
        }
        if BytesN::<32>::from(env.crypto().sha256(&pubkey.clone().into())) != pk_hash {
            return Err(Error::WrongPublicKey);
        }
        let nonce = Self::nonce(env.clone());

        let message = transfer_rotate_message(
            &env,
            &env.current_contract_address(),
            nonce,
            &token,
            &to,
            amount,
            &next_pk_hash,
        );
        let mut signed = Bytes::from_slice(&env, SEP53_PREFIX);
        signed.append(&message);
        let digest = env.crypto().sha256(&signed);
        env.crypto().ed25519_verify(&pubkey, &digest.into(), &sig);

        // Effects before the external token call.
        env.storage().instance().set(&DataKey::Nonce, &(nonce + 1));
        env.storage().instance().set(&DataKey::PkHash, &next_pk_hash);
        extend_instance_ttl(&env);

        // The token validates the amount.
        token::TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );

        TransferRotate { token, to, nonce, amount, next_pk_hash }.publish(&env);
        Ok(())
    }

    /// Anyone may keep the vault alive.
    pub fn extend_ttl(env: Env) {
        extend_instance_ttl(&env);
    }

    pub fn pk_hash(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::PkHash).unwrap()
    }

    pub fn nonce(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::Nonce).unwrap()
    }
}

fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// The human-readable message the vault key signs (as a SEP-53 message), so a wallet can
/// show exactly what is being authorized. Lines are separated by `\n`, with no trailing
/// newline; `amount` is in the token's base units and the hash is lowercase hex:
///
/// ```text
/// SoroBunker transfer_rotate
/// vault: C...
/// nonce: 0
/// token: C...
/// to: G...
/// amount: 250000000
/// next key hash: 4544cd0c...
/// ```
///
/// No network ID is needed: a contract address already commits to its network.
pub fn transfer_rotate_message(
    env: &Env,
    vault: &Address,
    nonce: u64,
    token: &Address,
    to: &Address,
    amount: i128,
    next_pk_hash: &BytesN<32>,
) -> Bytes {
    let mut m = Bytes::from_slice(env, b"SoroBunker transfer_rotate\nvault: ");
    append_strkey(&mut m, vault);
    m.extend_from_slice(b"\nnonce: ");
    append_decimal(&mut m, nonce.into());
    m.extend_from_slice(b"\ntoken: ");
    append_strkey(&mut m, token);
    m.extend_from_slice(b"\nto: ");
    append_strkey(&mut m, to);
    m.extend_from_slice(b"\namount: ");
    append_decimal(&mut m, amount);
    m.extend_from_slice(b"\nnext key hash: ");
    append_hex(&mut m, &next_pk_hash.to_array());
    m
}

fn append_strkey(m: &mut Bytes, address: &Address) {
    let s = address.to_string();
    let mut buf = [0u8; 69]; // longest strkey (muxed account)
    let len = s.len() as usize;
    s.copy_into_slice(&mut buf[..len]);
    m.extend_from_slice(&buf[..len]);
}

fn append_decimal(m: &mut Bytes, value: i128) {
    let mut buf = [0u8; 40];
    let mut i = buf.len();
    let mut n = value.unsigned_abs();
    loop {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    if value < 0 {
        i -= 1;
        buf[i] = b'-';
    }
    m.extend_from_slice(&buf[i..]);
}

fn append_hex(m: &mut Bytes, bytes: &[u8; 32]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut buf = [0u8; 64];
    for (i, b) in bytes.iter().enumerate() {
        buf[2 * i] = HEX[(b >> 4) as usize];
        buf[2 * i + 1] = HEX[(b & 0xf) as usize];
    }
    m.extend_from_slice(&buf);
}

#[cfg(test)]
mod test;
