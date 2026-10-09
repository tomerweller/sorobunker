import { Buffer } from "buffer";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
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
  if (rpc.Api.isSimulationError(sim)) throw new Error(simulationError(sim.error));
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
  if (rpc.Api.isSimulationError(sim)) throw new Error(simulationError(sim.error));
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
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new Error(`Submission rejected: ${sent.errorResult?.toXDR("base64") ?? "unknown error"}`);
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

/** Turn host errors into something readable; the vault's own errors are named. */
function simulationError(error: string): string {
  const vaultErrors: Record<string, string> = {
    "Error(Contract, #1)": "the key is not the vault's current key (WrongPublicKey)",
    "Error(Contract, #2)": "the next key is the current key (KeyReuse)",
  };
  for (const [code, text] of Object.entries(vaultErrors)) {
    if (error.includes(code)) return `Simulation failed: ${text}.`;
  }
  return `Simulation failed: ${error.split("\n")[0]}`;
}
