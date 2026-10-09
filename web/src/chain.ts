import { Buffer } from "buffer";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, RPC_URL } from "./config";
import type { Signer } from "./wallet";

export const server = new rpc.Server(RPC_URL);

/** Source for read-only simulations; it never needs to exist. */
const READ_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export const addr = (a: string) => new Address(a).toScVal();
export const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
export const bytes = (b: Uint8Array) => nativeToScVal(Buffer.from(b));

/** Call a contract function in simulation only and return its decoded result. */
export async function read<T>(contractId: string, method: string, ...args: xdr.ScVal[]): Promise<T> {
  const tx = new TransactionBuilder(new Account(READ_SOURCE, "0"), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw simulationError(sim.error);
  return scValToNative(sim.result!.retval) as T;
}

/**
 * Build a transaction from `source` with one operation, simulate it (which fails early,
 * before anything is signed, if the call would fail) and attach its resources.
 */
export async function prepare(source: string, op: xdr.Operation): Promise<Transaction> {
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw simulationError(sim.error);
  return rpc.assembleTransaction(tx, sim).build();
}

/** Sign with `source`, submit, and wait for the result. */
export async function signAndSubmit(
  signer: Signer,
  source: string,
  tx: Transaction,
): Promise<{ hash: string; returnValue?: xdr.ScVal }> {
  const signed = TransactionBuilder.fromXDR(
    await signer.signTransaction(tx.toXDR(), source),
    NETWORK_PASSPHRASE,
  );
  // Don't submit what the network will reject anyway: the source must have signed.
  const kp = Keypair.fromPublicKey(source);
  if (!signed.signatures.some((s) => kp.verify(signed.hash(), s.signature))) {
    throw new Error(`The wallet did not sign with ${source}. Select it in Freighter and try again.`);
  }
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new Error(`Submission rejected (${sent.errorResult?.result.type ?? "unknown error"}).`);
  }
  const res = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction ${sent.hash} failed (${res.status}).`);
  }
  return { hash: sent.hash, returnValue: res.returnValue };
}

export const invoke = (contractId: string, method: string, ...args: xdr.ScVal[]) =>
  new Contract(contractId).call(method, ...args);

export const createContract = (deployer: string, wasmHash: string, args: xdr.ScVal[]) =>
  Operation.createCustomContract({
    address: new Address(deployer),
    wasmHash: Buffer.from(wasmHash, "hex"),
    salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
    constructorArgs: args,
  });

/** Token (SEP-41 / Stellar Asset Contract) errors worth spelling out. */
const TOKEN_ERRORS: Record<number, string> = {
  6: "the account does not exist",
  8: "the amount is negative",
  10: "insufficient balance",
  11: "the balance is not authorized for this asset",
  13: "the recipient has no trustline for this asset",
};

/** A failed simulation, with the contract and error code that caused it when known. */
export class SimulationError extends Error {
  constructor(
    readonly raw: string,
    readonly contract?: string,
    readonly code?: number,
    readonly detail?: string,
  ) {
    super(SimulationError.describe(raw, contract, code, detail));
  }

  static describe(raw: string, contract?: string, code?: number, detail?: string): string {
    if (code === undefined) return `Simulation failed: ${raw.split("\n")[0]}`;
    // The vault's own codes are 1 and 2; a token's codes start higher, so these are safe.
    const known = TOKEN_ERRORS[code];
    if (known) return `The token transfer would fail: ${known}.`;
    return `Contract ${contract} failed with error #${code}${detail ? ` (${detail})` : ""}.`;
  }
}

/** The newest diagnostic error event names the contract that failed and why. */
function simulationError(raw: string): SimulationError {
  const m = /contract:(C[A-Z2-7]{55}), topics:\[error, Error\(Contract, #(\d+)\)\](?:, data:\["([^"]*)")?/.exec(raw);
  return m ? new SimulationError(raw, m[1], Number(m[2]), m[3]) : new SimulationError(raw);
}
