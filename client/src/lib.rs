//! Off-chain ed25519 keys and signing for SoroBunker.
//!
//! All keys derive from one 32-byte seed: key `n` signs the vault's transfer at nonce `n`.
//! `sk_n = sha256("SOROBUNKER_ED25519_SK_V1" || seed || n_be64)` (an ed25519 secret key).

use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};

const SK_DOMAIN: &[u8] = b"SOROBUNKER_ED25519_SK_V1";

pub type Seed = [u8; 32];

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn signing_key(seed: &Seed, n: u64) -> SigningKey {
    SigningKey::from_bytes(&sha256(&[SK_DOMAIN, seed, &n.to_be_bytes()]))
}

/// Ed25519 public key `n`. Revealed only when key `n` signs.
pub fn public_key(seed: &Seed, n: u64) -> [u8; 32] {
    signing_key(seed, n).verifying_key().to_bytes()
}

/// Hash of public key `n`; this is what the vault stores.
pub fn pk_hash(seed: &Seed, n: u64) -> [u8; 32] {
    sha256(&[&public_key(seed, n)])
}

/// Ed25519 signature of `digest` with key `n`.
pub fn sign(seed: &Seed, n: u64, digest: &[u8; 32]) -> [u8; 64] {
    signing_key(seed, n).sign(digest).to_bytes()
}

/// Validate a `G...` or `C...` strkey and return it in canonical form.
pub fn parse_address(s: &str) -> Result<String, String> {
    match stellar_strkey::Strkey::from_string(s).map_err(|e| format!("{s}: {e}"))? {
        k @ (stellar_strkey::Strkey::PublicKeyEd25519(_) | stellar_strkey::Strkey::Contract(_)) => {
            Ok(k.to_string().as_str().to_owned())
        }
        _ => Err(format!("{s}: expected a G... account or C... contract address")),
    }
}

/// The message the vault key signs; must match `transfer_rotate_message` in the contract.
pub fn transfer_rotate_message(
    vault: &str,
    nonce: u64,
    token: &str,
    to: &str,
    amount: i128,
    next_pk_hash: &[u8; 32],
) -> String {
    format!(
        "SoroBunker transfer_rotate\nvault: {vault}\nnonce: {nonce}\ntoken: {token}\nto: {to}\n\
         amount: {amount}\nnext key hash: {}",
        hex::encode(next_pk_hash)
    )
}

/// SEP-53 ("Sign and Verify Messages") prefix.
pub const SEP53_PREFIX: &[u8] = b"Stellar Signed Message:\n";

/// The SEP-53 hash of `message`: what an ed25519 key signs for that message.
pub fn sep53_hash(message: &[u8]) -> [u8; 32] {
    sha256(&[SEP53_PREFIX, message])
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    #[test]
    fn sign_verify_roundtrip() {
        let seed = [7u8; 32];
        let digest = sha256(&[b"hello"]);
        let pk = VerifyingKey::from_bytes(&public_key(&seed, 3)).unwrap();
        let sig = Signature::from_bytes(&sign(&seed, 3, &digest));
        assert!(pk.verify(&digest, &sig).is_ok());
        assert!(pk.verify(&sha256(&[b"other"]), &sig).is_err());
    }

    /// Test vectors from SEP-53.
    #[test]
    fn sep53_vectors() {
        let secret = "SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW";
        let key = SigningKey::from_bytes(
            &stellar_strkey::ed25519::PrivateKey::from_string(secret).unwrap().0,
        );
        assert_eq!(
            stellar_strkey::ed25519::PublicKey(key.verifying_key().to_bytes()).to_string(),
            "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L"
        );
        let vectors: [(Vec<u8>, &str); 3] = [
            (
                b"Hello, World!".to_vec(),
                "7cee5d6d885752104c85eea421dfdcb95abf01f1271d11c4bec3fcbd7874dccd\
                 6e2e98b97b8eb23b643cac4073bb77de5d07b0710139180ae9f3cbba78f2ba04",
            ),
            (
                "こんにちは、世界！".as_bytes().to_vec(),
                "083536eb95ecf32dce59b07fe7a1fd8cf814b2ce46f40d2a16e4ea1f6cecd980\
                 e04e6fbef9d21f98011c785a81edb85f3776a6e7d942b435eb0adc07da4d4604",
            ),
            (
                hex::decode("db36433f5b1ad415417cb3fb4de78c937b146dac4091484184388d76b92c685a")
                    .unwrap(),
                "540d7eee179f370bf634a49c1fa9fe4a58e3d7990b0207be336c04edfcc539ff\
                 8bd0c31bb2c0359b07c9651cb2ae104e4504657b5d17d43c69c7e50e23811b0d",
            ),
        ];
        for (message, expected) in vectors {
            let sig = key.sign(&sep53_hash(&message)).to_bytes();
            assert_eq!(hex::encode(sig), expected);
        }
    }

    #[test]
    fn keys_are_distinct() {
        let seed = [7u8; 32];
        assert_ne!(pk_hash(&seed, 3), pk_hash(&seed, 4));
        assert_ne!(pk_hash(&seed, 3), pk_hash(&[8u8; 32], 3));
        assert_eq!(pk_hash(&seed, 3), sha256(&[&public_key(&seed, 3)]));
    }
}
