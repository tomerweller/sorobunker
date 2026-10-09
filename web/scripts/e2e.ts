/**
 * End-to-end run on testnet of the same code the web app uses, with in-memory keys standing
 * in for Freighter: create a vault, deposit, then two transfers that each rotate the key.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { XLM_SAC } from "../src/config";
import { balance, createVault, deposit, transferRotate, vaultState } from "../src/vault";
import { keypairSigner } from "../src/wallet";
import { pkHash } from "../src/message";

const feePayer = Keypair.random();
const recipient = Keypair.random();
const vaultKeys = [Keypair.random(), Keypair.random(), Keypair.random()];
const signer = keypairSigner([feePayer, ...vaultKeys], () => feePayer);

async function friendbot(kp: Keypair) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot: ${res.status}`);
}

const XLM = 10_000_000n;
await Promise.all([friendbot(feePayer), friendbot(recipient)]);
console.log("fee payer", feePayer.publicKey());

const { vault, hash } = await createVault(signer, feePayer.publicKey(), vaultKeys[0].publicKey());
console.log("created vault", vault, hash);

await deposit(signer, feePayer.publicKey(), vault, XLM_SAC, 50n * XLM);
console.log("vault balance", await balance(XLM_SAC, vault));

for (const [n, amount] of [[0, 20n * XLM], [1, 5n * XLM]] as const) {
  const res = await transferRotate(signer, {
    vault,
    feePayer: feePayer.publicKey(),
    currentKey: vaultKeys[n].publicKey(),
    nextKey: vaultKeys[n + 1].publicKey(),
    token: XLM_SAC,
    to: recipient.publicKey(),
    amount,
  });
  const state = await vaultState(vault);
  console.log(`transfer ${n}: ${res.hash} nonce=${state.nonce}`);
  if (!state.pkHash.equals(pkHash(vaultKeys[n + 1].publicKey()))) throw new Error("key did not rotate");
}

const vaultBal = await balance(XLM_SAC, vault);
if (vaultBal !== 25n * XLM) throw new Error(`unexpected vault balance ${vaultBal}`);
console.log("vault balance", vaultBal, "- OK");
