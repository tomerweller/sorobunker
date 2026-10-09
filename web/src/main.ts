import "./style.css";
import { StrKey } from "@stellar/stellar-sdk";
import { EXPLORER_CONTRACT, EXPLORER_TX, XLM_SAC } from "./config";
import { pkHash, transferRotateMessage } from "./message";
import { allKeys, load, save, vaultKeys } from "./store";
import {
  balance,
  createVault,
  deposit,
  formatAmount,
  isKeyUsed,
  parseAmount,
  tokenInfo,
  transferRotate,
  vaultState,
  type TokenInfo,
  type VaultState,
} from "./vault";
import { connectFreighter, freighterAllowed, type Signer } from "./wallet";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);

/**
 * Everything read about the loaded vault, replaced only as a whole after a successful read,
 * so the screen never mixes one vault's (or token's) data with another's address.
 */
interface Loaded {
  vault: string;
  state: VaultState;
  token: string;
  info: TokenInfo;
  balance: bigint;
}

const store = load();
let signer: Signer | undefined;
let active: string | undefined;
let loaded: Loaded | undefined;
let nextKey: string | undefined;
let busy = false;

input("token").value = XLM_SAC;
if (store.vault) input("vault").value = store.vault;

// ---- log -------------------------------------------------------------------------------

function log(text: string, link?: { href: string; label: string }) {
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = ` ${link.label}`;
    line.append(a);
  }
  $("log").prepend(line);
}

/** Run one user action at a time, logging errors instead of throwing them. */
async function run(label: string, fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  render();
  try {
    await fn();
  } catch (e) {
    log(`${label} failed: ${errorText(e)}`);
  } finally {
    busy = false;
    render();
  }
}

/** The wallet kit rejects with plain `{ code, message }` objects rather than Errors. */
function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : (e as { message?: string })?.message;
  if (message === "Freighter is not connected") {
    return "Freighter was not found. Install the extension, unlock it, and try again.";
  }
  return message ?? JSON.stringify(e);
}

// ---- rendering -------------------------------------------------------------------------

const currentKey = () => (loaded ? vaultKeys(store, loaded.vault).currentKey : undefined);

function render() {
  $("active").textContent = active ?? "not connected";
  $("fee-payer").textContent = store.feePayer ?? "not set";
  button("connect").textContent = signer ? "Connected" : "Connect Freighter";
  button("connect").disabled = !!signer || busy;
  button("set-fee-payer").disabled = !active || busy;
  button("create").disabled = !active || !store.feePayer || busy;
  button("load").disabled = busy;
  button("deposit").disabled = !loaded || !store.feePayer || !signer || busy;

  $("vault-info").hidden = !loaded;
  if (loaded) {
    const { state, info } = loaded;
    $("nonce").textContent = state.nonce.toString();
    $("pk-hash").textContent = state.pkHash.toString("hex");
    $("balance").textContent = `${formatAmount(loaded.balance, info.decimals)} ${info.symbol}`;
    const key = currentKey();
    const matches = key ? pkHash(key).equals(state.pkHash) : false;
    $("current-key").textContent = key ?? "unknown";
    const status = $("current-status");
    status.textContent = key ? (matches ? "✓ matches" : "✗ does not match") : "";
    status.className = matches ? "ok" : "bad";
    button("set-current").hidden = matches;
    button("set-current").disabled = !active || busy;
    // Key n signs at nonce n-1, so the next key is number nonce + 2.
    $("next-name").textContent = `SoroBunker key ${state.nonce + 2n} — do not fund`;
  }

  button("set-next").disabled = !active || !loaded || busy;
  $("next-key").textContent = nextKey ?? "not set";
  const preview = previewMessage();
  $("message").textContent = preview.message ?? preview.hint;
  $("message").classList.toggle("hint-text", !preview.message);
  $("amount-note").textContent = preview.amountNote ?? "";
  button("send").disabled = !preview.message || !signer || !store.feePayer || busy;
}

/** The message to sign, or what is still missing. */
function previewMessage(): { message?: string; hint: string; amountNote?: string } {
  if (!loaded) return { hint: "Load or create a vault first." };
  if (!currentKey() || !pkHash(currentKey()!).equals(loaded.state.pkHash)) {
    return { hint: "Set the vault's current key (see Vault above)." };
  }
  if (input("token").value.trim() !== loaded.token) return { hint: "Loading the token…" };
  const to = input("to").value.trim();
  if (!to) return { hint: "Enter the recipient." };
  if (!StrKey.isValidEd25519PublicKey(to) && !StrKey.isValidContract(to)) {
    return { hint: "The recipient must be a G… account or C… contract address." };
  }
  if (to === currentKey() || to === nextKey) {
    return { hint: "Never send funds to a vault key: that puts it on-chain." };
  }
  let amount: bigint;
  try {
    amount = parseAmount(input("amount").value || "0", loaded.info.decimals);
  } catch (e) {
    return { hint: errorText(e) };
  }
  if (amount > loaded.balance) return { hint: "The vault does not hold that much." };
  if (!nextKey) return { hint: "Set the next key (steps above)." };
  const message = transferRotateMessage({
    vault: loaded.vault,
    nonce: loaded.state.nonce,
    token: loaded.token,
    to,
    amount,
    nextPkHash: pkHash(nextKey),
  });
  const { decimals, symbol } = loaded.info;
  const amountNote = `amount ${amount} = ${formatAmount(amount, decimals)} ${symbol} (${decimals} decimal places)`;
  return { message, hint: "", amountNote };
}

/** Read a vault and token; only replaces what is shown once every read has succeeded. */
async function refresh(vault: string, token: string) {
  const state = await vaultState(vault);
  const info = await tokenInfo(token);
  loaded = { vault, state, token, info, balance: await balance(token, vault) };
  render();
}

// ---- actions ---------------------------------------------------------------------------

async function connect() {
  // Only keep the signer once connecting fully succeeded, so a failure can be retried.
  const s = await connectFreighter();
  active = await s.activeAddress();
  signer = s;
  log(`Connected. Active account ${active}`);
  // Freighter has no change event through the kit, so poll the active account.
  setInterval(async () => {
    if (busy || !signer) return;
    try {
      const a = await signer.activeAddress();
      if (a !== active) {
        active = a;
        render();
      }
    } catch {
      // Wallet locked or on another network; keep the last known account.
    }
  }, 1500);
}

button("connect").onclick = () => run("Connect", connect);

button("set-fee-payer").onclick = () => {
  if (!active) return;
  if (allKeys(store).has(active)) {
    log("That account is a vault key; pick an ordinary funded account as the fee payer.");
    return;
  }
  store.feePayer = active;
  save(store);
  log(`Fee payer set to ${active}`);
  render();
};

const loadVault = () =>
  run("Load vault", async () => {
    const v = input("vault").value.trim();
    const previous = loaded?.vault;
    try {
      if (!StrKey.isValidContract(v)) throw new Error("Enter a vault contract address (C…).");
      // refresh() only replaces what is shown once every read succeeded.
      await refresh(v, input("token").value.trim());
    } catch (e) {
      // Keep the field in step with the vault still shown.
      if (previous) input("vault").value = previous;
      throw e;
    }
    if (v !== previous) nextKey = undefined;
    store.vault = v;
    save(store);
    log(`Loaded vault ${v}`, { href: EXPLORER_CONTRACT + v, label: "explorer" });
  });
button("load").onclick = loadVault;

button("create").onclick = () =>
  run("Create vault", async () => {
    const firstKey = active!;
    if (firstKey === store.feePayer) throw new Error("Select a new, unfunded account as the first key, not the fee payer.");
    if (allKeys(store).has(firstKey)) throw new Error("That account was already used as a vault key.");
    log(`Creating a vault with first key ${firstKey}…`);
    const { hash, vault: v } = await createVault(signer!, store.feePayer!, firstKey);
    vaultKeys(store, v).currentKey = firstKey;
    store.vault = v;
    save(store);
    input("vault").value = v;
    loaded = undefined;
    nextKey = undefined;
    log(`Created vault ${v}`, { href: EXPLORER_TX + hash, label: "transaction" });
    await refresh(v, input("token").value.trim());
  });

button("set-current").onclick = () => {
  if (!active || !loaded) return;
  if (!pkHash(active).equals(loaded.state.pkHash)) {
    log(`${active} is not the vault's current key: its hash does not match.`);
    return;
  }
  vaultKeys(store, loaded.vault).currentKey = active;
  save(store);
  log(`Current key set to ${active}`);
  render();
};

button("deposit").onclick = () =>
  run("Deposit", async () => {
    const { vault, token, info } = loaded!;
    const amount = parseAmount(input("deposit-amount").value, info.decimals);
    const { hash } = await deposit(signer!, store.feePayer!, vault, token, amount);
    log(`Deposited ${formatAmount(amount, info.decimals)} ${info.symbol}`, {
      href: EXPLORER_TX + hash,
      label: "transaction",
    });
    await refresh(vault, token);
  });

button("set-next").onclick = () =>
  run("Set next key", async () => {
    const key = active!;
    const reason =
      key === store.feePayer
        ? "That is the fee payer."
        : key === currentKey()
          ? "That is the current key. Add a new account in Freighter and select it."
          : allKeys(store).has(key)
            ? "That account was already used as a vault key."
            : (await isKeyUsed(loaded!.vault, key))
              ? "This vault already revealed that key, so it can never be its key again."
              : undefined;
    if (reason) throw new Error(`Cannot use ${key} as the next key: ${reason}`);
    nextKey = key;
    log(`Next key set to ${key}`);
  });

button("send").onclick = () =>
  run("Transfer", async () => {
    const { vault, token, info } = loaded!;
    const keys = vaultKeys(store, vault);
    const { hash } = await transferRotate(
      signer!,
      {
        vault,
        feePayer: store.feePayer!,
        currentKey: keys.currentKey!,
        nextKey: nextKey!,
        token,
        to: input("to").value.trim(),
        amount: parseAmount(input("amount").value || "0", info.decimals),
      },
      (text) => log(text),
    );
    log("Transfer confirmed.", { href: EXPLORER_TX + hash, label: "transaction" });
    keys.usedKeys.push(keys.currentKey!);
    keys.currentKey = nextKey;
    nextKey = undefined;
    save(store);
    await refresh(vault, token);
  });

for (const id of ["token", "to", "amount"]) input(id).oninput = () => render();
input("token").onchange = () =>
  run("Load token", async () => {
    const t = input("token").value.trim();
    if (!loaded || t === loaded.token) return;
    try {
      await refresh(loaded.vault, t);
    } catch (e) {
      input("token").value = loaded.token; // keep the field in step with what is shown
      throw e;
    }
  });

render();
(async () => {
  if (store.vault) await loadVault();
  // Reconnect without a prompt if Freighter already allows this site.
  if ((await freighterAllowed()) && !signer) await run("Connect", connect);
})();
