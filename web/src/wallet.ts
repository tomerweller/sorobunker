import { Buffer } from "buffer";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "./config";
import { sep53Hash } from "./message";

/**
 * Everything the app needs from a wallet. Kept separate so other key holders (a Ledger, or
 * in-memory keys for tests) can be swapped in for Freighter.
 */
export interface Signer {
  /** The account currently selected in the wallet. */
  activeAddress(): Promise<string>;
  /** SEP-53 signature of `message` by `address`; returns the raw 64-byte signature. */
  signMessage(message: string, address: string): Promise<Uint8Array>;
  /** Sign a transaction envelope with `address`; returns the signed XDR. */
  signTransaction(xdr: string, address: string): Promise<string>;
}

/** Freighter, through Stellar Wallets Kit. Loaded lazily so Node scripts never import it. */
export async function freighterSigner(): Promise<Signer> {
  const { StellarWalletsKit } = await import("@creit.tech/stellar-wallets-kit");
  const { FreighterModule, FREIGHTER_ID } = await import(
    "@creit.tech/stellar-wallets-kit/modules/freighter"
  );
  const { Networks } = await import("@creit.tech/stellar-wallets-kit/types");
  StellarWalletsKit.init({
    modules: [new FreighterModule()],
    selectedWalletId: FREIGHTER_ID,
    network: Networks.TESTNET,
  });

  return {
    async activeAddress() {
      const { networkPassphrase } = await StellarWalletsKit.getNetwork();
      if (networkPassphrase !== NETWORK_PASSPHRASE) {
        throw new Error("Switch Freighter to Testnet.");
      }
      return (await StellarWalletsKit.fetchAddress()).address;
    },
    async signMessage(message, address) {
      const { signedMessage, signerAddress } = await StellarWalletsKit.signMessage(message, {
        address,
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      if (signerAddress && signerAddress !== address) {
        throw new Error(`Freighter signed with ${signerAddress}, not ${address}.`);
      }
      return decodeSignature(signedMessage);
    },
    async signTransaction(xdr, address) {
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
        address,
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      return signedTxXdr;
    },
  };
}

/** Freighter returns base64; accept hex too in case a wallet version differs. */
function decodeSignature(s: string): Uint8Array {
  const bytes = /^[0-9a-f]{128}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (bytes.length !== 64) throw new Error("The wallet returned a malformed signature.");
  return bytes;
}

/** In-memory keys that sign like Freighter does. For scripts and tests only. */
export function keypairSigner(keys: Keypair[], active: () => Keypair): Signer {
  const find = (address: string) => {
    const kp = keys.find((k) => k.publicKey() === address);
    if (!kp) throw new Error(`No key for ${address}`);
    return kp;
  };
  return {
    async activeAddress() {
      return active().publicKey();
    },
    async signMessage(message, address) {
      return find(address).sign(sep53Hash(message));
    },
    async signTransaction(xdr, address) {
      const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
      tx.sign(find(address));
      return tx.toXDR();
    },
  };
}
