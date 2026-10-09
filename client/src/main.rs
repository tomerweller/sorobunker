use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use sorobunker_client as sb;

#[derive(Parser)]
#[command(name = "sorobunker", about = "Keys and signatures for a SoroBunker vault")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a new random seed file and print the initial key hash (for the constructor).
    Keygen {
        #[arg(long)]
        seed_file: PathBuf,
    },
    /// Print the public key hash for key `nonce`.
    PkHash {
        #[arg(long)]
        seed_file: PathBuf,
        #[arg(long)]
        nonce: u64,
    },
    /// Sign a transfer at the vault's current `nonce`.
    /// Prints JSON with the signed `message`, `next_pk_hash`, `pubkey` and `sig`.
    Sign {
        #[arg(long)]
        seed_file: PathBuf,
        /// Vault contract address (C...).
        #[arg(long)]
        contract: String,
        /// The vault's current nonce (`stellar contract invoke ... -- nonce`).
        #[arg(long)]
        nonce: u64,
        #[arg(long)]
        token: String,
        #[arg(long)]
        to: String,
        #[arg(long, allow_hyphen_values = true)]
        amount: i128,
    },
}

fn main() {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), String> {
    match cli.cmd {
        Cmd::Keygen { seed_file } => {
            let mut seed = [0u8; 32];
            getrandom::fill(&mut seed).map_err(|e| e.to_string())?;
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&seed_file)
                .map_err(|e| format!("{}: {e}", seed_file.display()))?;
            writeln!(f, "{}", hex::encode(seed)).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
            println!("{}", hex::encode(sb::pk_hash(&seed, 0)));
        }
        Cmd::PkHash { seed_file, nonce } => {
            let seed = read_seed(&seed_file)?;
            println!("{}", hex::encode(sb::pk_hash(&seed, nonce)));
        }
        Cmd::Sign { seed_file, contract, nonce, token, to, amount } => {
            if amount < 0 {
                return Err("amount must be non-negative".into());
            }
            let seed = read_seed(&seed_file)?;
            let next_pk_hash = sb::pk_hash(&seed, nonce + 1);
            let message = sb::transfer_rotate_message(
                &sb::parse_address(&contract)?,
                nonce,
                &sb::parse_address(&token)?,
                &sb::parse_address(&to)?,
                amount,
                &next_pk_hash,
            );
            let digest = sb::sep53_hash(message.as_bytes());
            let out = serde_json::json!({
                "nonce": nonce,
                "message": message,
                "next_pk_hash": hex::encode(next_pk_hash),
                "pubkey": hex::encode(sb::public_key(&seed, nonce)),
                "sig": hex::encode(sb::sign(&seed, nonce, &digest)),
            });
            println!("{out}");
        }
    }
    Ok(())
}

fn read_seed(path: &Path) -> Result<sb::Seed, String> {
    let s = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let bytes = hex::decode(s.trim()).map_err(|e| format!("{}: {e}", path.display()))?;
    bytes
        .try_into()
        .map_err(|_| format!("{}: seed must be 32 bytes of hex", path.display()))
}
