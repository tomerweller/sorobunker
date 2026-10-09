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
  parseAmount,
  tokenInfo,
  transferRotate,
  vaultState,
  type TokenInfo,
  type VaultState,
} from "./vault";
import { freighterSigner, type Signer } from "./wallet";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);

const store = load();
let signer: Signer | undefined;
let active: string | undefined;
let state: VaultState | undefined;
let token: TokenInfo | undefined;
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

const vault = () => store.vault;
const currentKey = () => (vault() ? vaultKeys(store, vault()!).currentKey : undefined);

function render() {
  $("active").textContent = active ?? "not connected";
  $("fee-payer").textContent = store.feePayer ?? "not set";
  button("connect").textContent = signer ? "Connected" : "Connect Freighter";
  button("connect").disabled = !!signer || busy;
  button("set-fee-payer").disabled = !active || busy;
  button("create").disabled = !active || !store.feePayer || busy;
  button("load").disabled = busy;
  button("deposit").disabled = !state || !store.feePayer || !signer || busy;

  $("vault-info").hidden = !state;
  if (state && vault()) {
    $("nonce").textContent = state.nonce.toString();
    $("pk-hash").textContent = state.pkHash.toString("hex");
    const key = currentKey();
    const matches = key ? pkHash(key).equals(state.pkHash) : false;
    $("current-key").textContent = key ?? "unknown";
    const status = $("current-status");
    status.textContent = key ? (matches ? "✓ matches" : "✗ does not match") : "";
    status.className = matches ? "ok" : "bad";
    button("set-current").hidden = matches;
    button("set-current").disabled = !active || busy;
  }

  button("set-next").disabled = !active || !state || busy;
  $("next-key").textContent = nextKey ?? "not set";
  const message = previewMessage();
  $("message").textContent = message ?? "Load a vault, set the next key and fill in the transfer.";
  button("send").disabled =
    !message || !signer || !store.feePayer || !currentKey() || busy;
}

function transferInputs() {
  const t = input("token").value.trim();
  const to = input("to").value.trim();
  const valid = (a: string) => StrKey.isValidEd25519PublicKey(a) || StrKey.isValidContract(a);
  if (!valid(t) || !valid(to) || !token) return undefined;
  try {
    return { token: t, to, amount: parseAmount(input("amount").value || "0", token.decimals) };
  } catch {
    return undefined;
  }
}

function previewMessage(): string | undefined {
  const t = transferInputs();
  if (!t || !state || !vault() || !nextKey) return undefined;
  return transferRotateMessage({ vault: vault()!, nonce: state.nonce, ...t, nextPkHash: pkHash(nextKey) });
}

async function refreshVault() {
  const v = vault();
  if (!v) return;
  const t = input("token").value.trim();
  [state, token] = await Promise.all([vaultState(v), tokenInfo(t)]);
  const bal = await balance(t, v);
  $("balance").textContent = `${formatAmount(bal, token.decimals)} ${token.symbol}`;
  render();
}

// ---- actions ---------------------------------------------------------------------------

button("connect").onclick = () =>
  run("Connect", async () => {
    signer = await freighterSigner();
    active = await signer.activeAddress();
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
  });

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

button("load").onclick = () =>
  run("Load vault", async () => {
    const v = input("vault").value.trim();
    if (!StrKey.isValidContract(v)) throw new Error("Enter a vault contract address (C…).");
    store.vault = v;
    save(store);
    nextKey = undefined;
    await refreshVault();
    log(`Loaded vault ${v}`, { href: EXPLORER_CONTRACT + v, label: "explorer" });
  });

button("create").onclick = () =>
  run("Create vault", async () => {
    const firstKey = active!;
    if (firstKey === store.feePayer) throw new Error("Select a new, unfunded account as the first key, not the fee payer.");
    if (allKeys(store).has(firstKey)) throw new Error("That account was already used as a vault key.");
    log(`Creating a vault with first key ${firstKey}…`);
    const { hash, vault: v } = await createVault(signer!, store.feePayer!, firstKey);
    store.vault = v;
    vaultKeys(store, v).currentKey = firstKey;
    save(store);
    input("vault").value = v;
    log(`Created vault ${v}`, { href: EXPLORER_TX + hash, label: "transaction" });
    await refreshVault();
  });

button("set-current").onclick = () => {
  if (!active || !state || !vault()) return;
  if (!pkHash(active).equals(state.pkHash)) {
    log(`${active} is not the vault's current key: its hash does not match.`);
    return;
  }
  vaultKeys(store, vault()!).currentKey = active;
  save(store);
  log(`Current key set to ${active}`);
  render();
};

button("deposit").onclick = () =>
  run("Deposit", async () => {
    const amount = parseAmount(input("deposit-amount").value, token!.decimals);
    const t = input("token").value.trim();
    const { hash } = await deposit(signer!, store.feePayer!, vault()!, t, amount);
    log(`Deposited ${formatAmount(amount, token!.decimals)} ${token!.symbol}`, {
      href: EXPLORER_TX + hash,
      label: "transaction",
    });
    await refreshVault();
  });

button("set-next").onclick = () => {
  if (!active) return;
  const reason =
    active === store.feePayer
      ? "That is the fee payer."
      : active === currentKey()
        ? "That is the current key. Add a new account in Freighter and select it."
        : allKeys(store).has(active)
          ? "That account was already used as a vault key."
          : undefined;
  if (reason) {
    log(`Cannot use ${active} as the next key: ${reason}`);
    return;
  }
  nextKey = active;
  log(`Next key set to ${active}`);
  render();
};

button("send").onclick = () =>
  run("Transfer", async () => {
    const t = transferInputs()!;
    const v = vault()!;
    const keys = vaultKeys(store, v);
    await transferRotate(
      signer!,
      { vault: v, feePayer: store.feePayer!, currentKey: keys.currentKey!, nextKey: nextKey!, ...t },
      (text) => log(text),
    ).then(({ hash }) => log("Transfer confirmed.", { href: EXPLORER_TX + hash, label: "transaction" }));
    keys.usedKeys.push(keys.currentKey!);
    keys.currentKey = nextKey;
    nextKey = undefined;
    save(store);
    await refreshVault();
  });

for (const id of ["token", "to", "amount"]) input(id).oninput = () => render();
input("token").onchange = () => run("Load token", refreshVault);

render();
if (store.vault) button("load").click();
