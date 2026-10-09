extern crate std;

use std::{fmt::Debug, string::String, vec, vec::Vec};

use soroban_sdk::{
    testutils::Address as _, token::StellarAssetClient, token::TokenClient, Address, BytesN, Env,
};
use sorobunker_client as sb;

use crate::{transfer_rotate_message, Error, SoroBunker, SoroBunkerClient};

const SEED: sb::Seed = [42u8; 32];

struct Setup<'a> {
    env: Env,
    vault: SoroBunkerClient<'a>,
    token: TokenClient<'a>,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    let pk0 = BytesN::from_array(&env, &sb::pk_hash(&SEED, 0));
    let vault_id = env.register(SoroBunker, (pk0,));

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    env.mock_all_auths();
    StellarAssetClient::new(&env, &sac.address()).mint(&vault_id, &1_000);
    // From here on, no auth is mocked: the vault must move funds on the strength of
    // its own signature check alone.
    env.set_auths(&[]);

    Setup {
        vault: SoroBunkerClient::new(&env, &vault_id),
        token: TokenClient::new(&env, &sac.address()),
        env,
    }
}

fn strkey(a: &Address) -> String {
    let s = a.to_string();
    let mut buf = vec![0u8; s.len() as usize];
    s.copy_into_slice(&mut buf);
    String::from_utf8(buf).unwrap()
}

struct Signed {
    next: BytesN<32>,
    pubkey: BytesN<32>,
    sig: BytesN<64>,
}

/// What the client produces for a transfer at nonce `n` signed with `seed`'s key `n`,
/// rotating to `seed`'s key `n + 1`.
fn sign(
    env: &Env,
    vault: &Address,
    seed: &sb::Seed,
    n: u64,
    token: &Address,
    to: &Address,
    amount: i128,
) -> Signed {
    sign_with_next(env, vault, seed, n, token, to, amount, sb::pk_hash(seed, n + 1))
}

/// Like [`sign`], but rotating to an arbitrary key hash.
#[allow(clippy::too_many_arguments)]
fn sign_with_next(
    env: &Env,
    vault: &Address,
    seed: &sb::Seed,
    n: u64,
    token: &Address,
    to: &Address,
    amount: i128,
    next: [u8; 32],
) -> Signed {
    let message =
        sb::transfer_rotate_message(&strkey(vault), n, &strkey(token), &strkey(to), amount, &next);
    let digest = sb::sep53_hash(message.as_bytes());
    Signed {
        next: BytesN::from_array(env, &next),
        pubkey: BytesN::from_array(env, &sb::public_key(seed, n)),
        sig: BytesN::from_array(env, &sb::sign(seed, n, &digest)),
    }
}

/// `ed25519_verify` traps on a bad signature rather than returning a contract error.
fn assert_trapped<T: Debug, E: Debug>(res: Result<T, Result<Error, E>>, ctx: impl Debug) {
    assert!(matches!(res, Err(Err(_))), "{ctx:?}: expected a host trap, got {res:?}");
}

/// A fixed example of the signed message. The web app's tests check the same string.
pub const MESSAGE_VECTOR: &str = "SoroBunker transfer_rotate
vault: CD5WS6EMV4GBZDVIBKJVO4RSQPFFKSAS5OQCQFJT7A2NV27KSDZDYKX6
nonce: 7
token: CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
to: GBYUK7JWE4DX3Y2YR6TM755BVUVEVL4723TQ2SSUHH7YURGYRFNVSTLO
amount: -170141183460469231731687303715884105728
next key hash: 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

#[test]
fn message_matches_vector_and_client() {
    let env = Env::default();
    let vault = Address::from_str(&env, "CD5WS6EMV4GBZDVIBKJVO4RSQPFFKSAS5OQCQFJT7A2NV27KSDZDYKX6");
    let token = Address::from_str(&env, "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
    let to = Address::from_str(&env, "GBYUK7JWE4DX3Y2YR6TM755BVUVEVL4723TQ2SSUHH7YURGYRFNVSTLO");
    let next: [u8; 32] = core::array::from_fn(|i| i as u8);

    let ours = transfer_rotate_message(
        &env,
        &vault,
        7,
        &token,
        &to,
        i128::MIN,
        &BytesN::from_array(&env, &next),
    );
    let ours: Vec<u8> = ours.iter().collect();
    assert_eq!(String::from_utf8(ours).unwrap(), MESSAGE_VECTOR);

    let theirs =
        sb::transfer_rotate_message(&strkey(&vault), 7, &strkey(&token), &strkey(&to), i128::MIN, &next);
    assert_eq!(theirs, MESSAGE_VECTOR);
}

#[test]
fn transfer_and_rotate() {
    let s = setup();
    let to = Address::generate(&s.env);
    let t = sign(&s.env, &s.vault.address, &SEED, 0, &s.token.address, &to, 100);

    s.vault.transfer_rotate(&s.token.address, &to, &100, &t.next, &t.pubkey, &t.sig);

    assert_eq!(s.token.balance(&to), 100);
    assert_eq!(s.token.balance(&s.vault.address), 900);
    assert_eq!(s.vault.nonce(), 1);
    assert_eq!(s.vault.pk_hash(), t.next);
}

#[test]
fn chain_of_transfers() {
    let s = setup();
    let to = Address::generate(&s.env);
    for n in 0..5 {
        let t = sign(&s.env, &s.vault.address, &SEED, n, &s.token.address, &to, 10);
        s.vault.transfer_rotate(&s.token.address, &to, &10, &t.next, &t.pubkey, &t.sig);
    }
    assert_eq!(s.token.balance(&to), 50);
    assert_eq!(s.vault.nonce(), 5);
    assert_eq!(s.vault.pk_hash().to_array(), sb::pk_hash(&SEED, 5));
}

#[test]
fn replay_rejected() {
    let s = setup();
    let to = Address::generate(&s.env);
    let t = sign(&s.env, &s.vault.address, &SEED, 0, &s.token.address, &to, 100);
    s.vault.transfer_rotate(&s.token.address, &to, &100, &t.next, &t.pubkey, &t.sig);

    // Same call again: the stored key has rotated to `t.next`.
    let res = s.vault.try_transfer_rotate(&s.token.address, &to, &100, &t.next, &t.pubkey, &t.sig);
    assert_eq!(res, Err(Ok(Error::KeyReuse)));
    // With a fresh next key, the old public key no longer matches the stored hash.
    let other_next = BytesN::from_array(&s.env, &[9u8; 32]);
    let res =
        s.vault.try_transfer_rotate(&s.token.address, &to, &100, &other_next, &t.pubkey, &t.sig);
    assert_eq!(res, Err(Ok(Error::WrongPublicKey)));
    assert_eq!(s.token.balance(&to), 100);
}

#[test]
fn tampered_fields_rejected() {
    let s = setup();
    let to = Address::generate(&s.env);
    let attacker = Address::generate(&s.env);
    let other_token = s
        .env
        .register_stellar_asset_contract_v2(Address::generate(&s.env))
        .address();
    let t = sign(&s.env, &s.vault.address, &SEED, 0, &s.token.address, &to, 100);
    let evil_next = BytesN::from_array(&s.env, &sb::pk_hash(&[1u8; 32], 0));

    let cases = [
        (s.token.address.clone(), attacker.clone(), 100, t.next.clone()),
        (s.token.address.clone(), to.clone(), 101, t.next.clone()),
        (other_token, to.clone(), 100, t.next.clone()),
        (s.token.address.clone(), to.clone(), 100, evil_next),
    ];
    for (token, to, amount, next) in cases {
        let res = s.vault.try_transfer_rotate(&token, &to, &amount, &next, &t.pubkey, &t.sig);
        assert_trapped(res, (&token, &to, amount));
    }

    // A single flipped bit in the signature also fails.
    let mut bad = t.sig.to_array();
    bad[0] ^= 1;
    let bad = BytesN::from_array(&s.env, &bad);
    let res = s.vault.try_transfer_rotate(&s.token.address, &to, &100, &t.next, &t.pubkey, &bad);
    assert_trapped(res, "flipped sig bit");

    assert_eq!(s.vault.nonce(), 0);
    assert_eq!(s.token.balance(&s.vault.address), 1_000);
}

#[test]
fn wrong_key_rejected() {
    let s = setup();
    let to = Address::generate(&s.env);
    // Wrong seed, and right seed but wrong key index: the public key hash does not match.
    for (seed, n) in [([1u8; 32], 0), (SEED, 1)] {
        let t = sign(&s.env, &s.vault.address, &seed, n, &s.token.address, &to, 100);
        let res =
            s.vault.try_transfer_rotate(&s.token.address, &to, &100, &t.next, &t.pubkey, &t.sig);
        assert_eq!(res, Err(Ok(Error::WrongPublicKey)));
    }

    // Right public key, but signed by another key.
    let t = sign(&s.env, &s.vault.address, &[1u8; 32], 0, &s.token.address, &to, 100);
    let pk0 = BytesN::from_array(&s.env, &sb::public_key(&SEED, 0));
    let res = s.vault.try_transfer_rotate(&s.token.address, &to, &100, &t.next, &pk0, &t.sig);
    assert_trapped(res, "foreign signature");
}

#[test]
fn signature_bound_to_vault() {
    let s = setup();
    // A second vault controlled by the same seed.
    let pk0 = BytesN::from_array(&s.env, &sb::pk_hash(&SEED, 0));
    let other_vault = s.env.register(SoroBunker, (pk0,));
    let to = Address::generate(&s.env);

    let t = sign(&s.env, &other_vault, &SEED, 0, &s.token.address, &to, 100);
    let res = s.vault.try_transfer_rotate(&s.token.address, &to, &100, &t.next, &t.pubkey, &t.sig);
    assert_trapped(res, "other vault");
}

#[test]
fn zero_amount_rotates() {
    let s = setup();
    let to = Address::generate(&s.env);
    let t = sign(&s.env, &s.vault.address, &SEED, 0, &s.token.address, &to, 0);
    s.vault.transfer_rotate(&s.token.address, &to, &0, &t.next, &t.pubkey, &t.sig);
    assert_eq!(s.vault.nonce(), 1);
    assert_eq!(s.vault.pk_hash(), t.next);
    assert_eq!(s.token.balance(&s.vault.address), 1_000);
}

#[test]
fn used_keys_cannot_return() {
    let s = setup();
    let to = Address::generate(&s.env);
    for n in 0..2 {
        let t = sign(&s.env, &s.vault.address, &SEED, n, &s.token.address, &to, 1);
        s.vault.transfer_rotate(&s.token.address, &to, &1, &t.next, &t.pubkey, &t.sig);
    }
    let used = |n: u64| s.vault.is_key_used(&BytesN::from_array(&s.env, &sb::pk_hash(&SEED, n)));
    assert!(used(0) && used(1));
    assert!(!used(2), "the current key is not revealed yet");
    assert!(!used(3));

    // Key 2 (current) correctly signs a rotation back to key 0 or 1: still rejected.
    for old in 0..2 {
        let t = sign_with_next(
            &s.env,
            &s.vault.address,
            &SEED,
            2,
            &s.token.address,
            &to,
            1,
            sb::pk_hash(&SEED, old),
        );
        let res = s.vault.try_transfer_rotate(&s.token.address, &to, &1, &t.next, &t.pubkey, &t.sig);
        assert_eq!(res, Err(Ok(Error::KeyReuse)));
    }
    assert_eq!(s.vault.nonce(), 2);
}

#[test]
fn key_reuse_rejected() {
    let s = setup();
    let to = Address::generate(&s.env);
    let pubkey = BytesN::from_array(&s.env, &sb::public_key(&SEED, 0));
    let sig = BytesN::from_array(&s.env, &[0u8; 64]);
    let current = s.vault.pk_hash();
    let res = s.vault.try_transfer_rotate(&s.token.address, &to, &1, &current, &pubkey, &sig);
    assert_eq!(res, Err(Ok(Error::KeyReuse)));
}

#[test]
fn negative_amount_rejected_by_token() {
    let s = setup();
    let to = Address::generate(&s.env);
    let t = sign(&s.env, &s.vault.address, &SEED, 0, &s.token.address, &to, -1);
    let res = s.vault.try_transfer_rotate(&s.token.address, &to, &-1, &t.next, &t.pubkey, &t.sig);
    assert_trapped(res, "negative amount");
    assert_eq!(s.vault.nonce(), 0);
    assert_eq!(s.token.balance(&s.vault.address), 1_000);
}

#[test]
fn failed_transfer_can_be_resubmitted() {
    let s = setup();
    let to = Address::generate(&s.env);
    let t = sign(&s.env, &s.vault.address, &SEED, 0, &s.token.address, &to, 5_000);

    // Insufficient balance: the whole call reverts, the key does not rotate.
    let res = s.vault.try_transfer_rotate(&s.token.address, &to, &5_000, &t.next, &t.pubkey, &t.sig);
    assert!(res.is_err());
    assert_eq!(s.vault.nonce(), 0);

    // Top up, then resubmit the very same signature.
    s.env.mock_all_auths();
    StellarAssetClient::new(&s.env, &s.token.address).mint(&s.vault.address, &4_000);
    s.env.set_auths(&[]);
    s.vault.transfer_rotate(&s.token.address, &to, &5_000, &t.next, &t.pubkey, &t.sig);
    assert_eq!(s.token.balance(&to), 5_000);
}

#[test]
fn fits_in_budget() {
    let s = setup();
    let to = Address::generate(&s.env);
    let t = sign(&s.env, &s.vault.address, &SEED, 0, &s.token.address, &to, 100);

    s.env.cost_estimate().budget().reset_default();
    s.vault.transfer_rotate(&s.token.address, &to, &100, &t.next, &t.pubkey, &t.sig);
    let cpu = s.env.cost_estimate().budget().cpu_instruction_cost();
    let mem = s.env.cost_estimate().budget().memory_bytes_cost();
    std::println!("transfer_rotate: cpu={cpu} mem={mem}");
    assert!(cpu < 10_000_000, "cpu={cpu}");
}

/// Same as `fits_in_budget`, but against the real wasm (run `stellar contract build` first),
/// so guest execution is metered too. Skipped if the wasm has not been built.
#[test]
fn wasm_fits_in_budget() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/wasm32v1-none/release/sorobunker.wasm");
    let Ok(wasm) = std::fs::read(path) else {
        std::println!("skipping: {path} not built");
        return;
    };
    let s = setup();
    let pk0 = BytesN::from_array(&s.env, &sb::pk_hash(&SEED, 0));
    let vault = SoroBunkerClient::new(&s.env, &s.env.register(wasm.as_slice(), (pk0,)));
    s.env.mock_all_auths();
    StellarAssetClient::new(&s.env, &s.token.address).mint(&vault.address, &1_000);
    s.env.set_auths(&[]);
    let to = Address::generate(&s.env);
    let t = sign(&s.env, &vault.address, &SEED, 0, &s.token.address, &to, 100);

    s.env.cost_estimate().budget().reset_default();
    vault.transfer_rotate(&s.token.address, &to, &100, &t.next, &t.pubkey, &t.sig);
    let cpu = s.env.cost_estimate().budget().cpu_instruction_cost();
    let mem = s.env.cost_estimate().budget().memory_bytes_cost();
    std::println!("wasm transfer_rotate: cpu={cpu} mem={mem}");
    assert_eq!(s.token.balance(&to), 100);
    assert!(cpu < 10_000_000, "cpu={cpu}");
}
