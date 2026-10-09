import { Buffer } from "buffer";
import { hash, Keypair, StrKey } from "@stellar/stellar-sdk";

/** SEP-53 ("Sign and Verify Messages") prefix. */
const SEP53_PREFIX = "Stellar Signed Message:\n";

export interface TransferRotate {
  vault: string;
  nonce: bigint;
  token: string;
  to: string;
  amount: bigint;
  nextPkHash: Uint8Array;
}

/** The message the vault key signs; must match `transfer_rotate_message` in the contract. */
export function transferRotateMessage(t: TransferRotate): string {
  return [
    "SoroBunker transfer_rotate",
    `vault: ${t.vault}`,
    `nonce: ${t.nonce}`,
    `token: ${t.token}`,
    `to: ${t.to}`,
    `amount: ${t.amount}`,
    `next key hash: ${Buffer.from(t.nextPkHash).toString("hex")}`,
  ].join("\n");
}

/** The SEP-53 hash of a message: what an ed25519 key signs for it. */
export function sep53Hash(message: string): Buffer {
  return Buffer.from(hash(Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from(message, "utf8")])));
}

/** What the vault stores for a key: sha256 of the account's raw ed25519 public key. */
export function pkHash(address: string): Buffer {
  return Buffer.from(hash(StrKey.decodeEd25519PublicKey(address)));
}

/** Check a SEP-53 signature locally, before anything is sent to the network. */
export function verifyMessage(address: string, message: string, sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  return Keypair.fromPublicKey(address).verify(sep53Hash(message), Buffer.from(sig));
}
