import { Buffer } from "buffer";
import { Address, StrKey } from "@stellar/stellar-sdk";
import { VAULT_WASM_HASH } from "./config";
import { addr, bytes, createContract, i128, invoke, prepare, read, signAndSubmit } from "./chain";
import { pkHash, transferRotateMessage, verifyMessage } from "./message";
import type { Signer } from "./wallet";

export interface VaultState {
  nonce: bigint;
  pkHash: Buffer;
}

export async function vaultState(vault: string): Promise<VaultState> {
  const [nonce, hash] = await Promise.all([
    read<bigint>(vault, "nonce"),
    read<Buffer>(vault, "pk_hash"),
  ]);
  return { nonce: BigInt(nonce), pkHash: Buffer.from(hash) };
}

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

export async function tokenInfo(token: string): Promise<TokenInfo> {
  const [symbol, decimals] = await Promise.all([
    read<string>(token, "symbol"),
    read<number>(token, "decimals"),
  ]);
  // The native asset's contract reports its symbol as "native".
  return { symbol: symbol === "native" ? "XLM" : symbol, decimals: Number(decimals) };
}

export async function balance(token: string, id: string): Promise<bigint> {
  return BigInt(await read<bigint>(token, "balance", addr(id)));
}

/** Deploy a new vault whose first key is `firstKey`. The fee payer deploys and pays. */
export async function createVault(signer: Signer, feePayer: string, firstKey: string) {
  const op = createContract(feePayer, VAULT_WASM_HASH, [bytes(pkHash(firstKey))]);
  const { hash, returnValue } = await signAndSubmit(signer, feePayer, await prepare(feePayer, op));
  const vault = Address.fromScVal(returnValue!).toString();
  return { hash, vault };
}

/** Move `amount` of `token` from the fee payer's account into the vault. */
export async function deposit(signer: Signer, feePayer: string, vault: string, token: string, amount: bigint) {
  const op = invoke(token, "transfer", addr(feePayer), addr(vault), i128(amount));
  return signAndSubmit(signer, feePayer, await prepare(feePayer, op));
}

export interface TransferParams {
  vault: string;
  feePayer: string;
  currentKey: string;
  nextKey: string;
  token: string;
  to: string;
  amount: bigint;
}

export type Step = (text: string) => void;

/**
 * The full transfer: the current key signs the readable message, the signature is
 * checked locally, the call is simulated, and only then does the fee payer sign and submit.
 */
export async function transferRotate(signer: Signer, p: TransferParams, step: Step = () => {}) {
  checkRoles(p);
  const { nonce, pkHash: stored } = await vaultState(p.vault);
  if (!pkHash(p.currentKey).equals(stored)) {
    throw new Error(`${p.currentKey} is not the vault's current key.`);
  }

  const message = transferRotateMessage({
    vault: p.vault,
    nonce,
    token: p.token,
    to: p.to,
    amount: p.amount,
    nextPkHash: pkHash(p.nextKey),
  });
  step(`Waiting for the current key to sign:\n${message}`);
  const sig = await signer.signMessage(message, p.currentKey);
  if (!verifyMessage(p.currentKey, message, sig)) {
    throw new Error("The wallet's signature does not verify; nothing was sent.");
  }

  step("Signature verified locally. Simulating the transfer…");
  const op = invoke(
    p.vault,
    "transfer_rotate",
    addr(p.token),
    addr(p.to),
    i128(p.amount),
    bytes(pkHash(p.nextKey)),
    bytes(StrKey.decodeEd25519PublicKey(p.currentKey)),
    bytes(sig),
  );
  const tx = await prepare(p.feePayer, op);

  step("Simulation passed. Waiting for the fee payer to sign the transaction…");
  const res = await signAndSubmit(signer, p.feePayer, tx);
  step(`Confirmed: ${res.hash}`);
  return res;
}

/** The three keys must stay separate, and funds must never go to an unexposed key. */
function checkRoles(p: TransferParams) {
  if (p.nextKey === p.currentKey) throw new Error("The next key must differ from the current key.");
  if (p.nextKey === p.feePayer) throw new Error("The fee payer cannot be a vault key.");
  if (p.currentKey === p.feePayer) throw new Error("The fee payer cannot be a vault key.");
  if (p.to === p.nextKey || p.to === p.currentKey) {
    throw new Error("Never send funds to a vault key: that puts it on-chain.");
  }
}

/** Parse a decimal amount like "12.5" into base units. */
export function parseAmount(s: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`Invalid amount: ${s}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places.`);
  return BigInt(m[1] + frac.padEnd(decimals, "0"));
}

export function formatAmount(n: bigint, decimals: number): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
