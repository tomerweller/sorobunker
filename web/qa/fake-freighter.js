// Fake Freighter for agent-driven QA: answers @stellar/freighter-api's window.postMessage
// protocol (what the extension's content script does) with real ed25519 keys, so an agent or
// a DevTools session can drive every wallet flow without the extension. Testnet only: keys
// are kept in localStorage so they survive reloads.
//
// Inject it into the running dev server's page (it uses top-level await and return):
//   const src = (await import("/qa/fake-freighter.js?raw")).default;
//   await new (Object.getPrototypeOf(async function () {}).constructor)(src)();
//
// Controls on window.__ff:
//   add(name)              new account, made active (like adding one in Freighter); the
//                          site isn't allowed to see it until it requests access again
//   select(name|address)   make an account active
//   fund(name)             fund an account with friendbot
//   list()                 accounts, * marks the active one
//   network                "TESTNET" or "PUBLIC"
//   rejectNext             one-shot decline: "access" | "message" | "tx"
//   ignoreAccountToSign    sign with the active account even when another was requested
//   corruptSignature       flip a bit in message signatures
//   requests, counts       what the app asked for (signing requests are logged in full)
const SB = (await import("https://cdn.jsdelivr.net/npm/@stellar/stellar-base@15.0.0/+esm")).default;
const { Keypair, TransactionBuilder, Networks } = SB;
if (window.__ff) throw new Error("fake Freighter already installed; reload first");
const REQ = "FREIGHTER_EXTERNAL_MSG_REQUEST";
const RES = "FREIGHTER_EXTERNAL_MSG_RESPONSE";
const STORE = "__fakeFreighter";

const saved = JSON.parse(localStorage.getItem(STORE) || "null") || { accounts: [], active: -1, allowed: [] };
const accounts = saved.accounts.map((a) => ({ name: a.name, kp: Keypair.fromSecret(a.secret) }));
const ff = (window.__ff = {
  accounts,
  active: saved.active,
  // Like Freighter, access is granted per account. Older saves kept one flag for all accounts.
  allowed: Array.isArray(saved.allowed) ? saved.allowed : saved.allowed ? accounts.map((a) => a.kp.publicKey()) : [],
  network: "TESTNET",
  // One-shot rejection: "access" | "message" | "tx"
  rejectNext: null,
  // Misbehaviours, to test the dapp's defences
  ignoreAccountToSign: false,
  corruptSignature: false,
  requests: [],
  counts: {},
  save() {
    localStorage.setItem(STORE, JSON.stringify({
      accounts: this.accounts.map((a) => ({ name: a.name, secret: a.kp.secret() })),
      active: this.active,
      allowed: this.allowed,
    }));
  },
  add(name) {
    this.accounts.push({ name, kp: Keypair.random() });
    this.active = this.accounts.length - 1; // Freighter selects a newly added account
    this.save();
    return this.address();
  },
  select(name) {
    const i = this.accounts.findIndex((a) => a.name === name || a.kp.publicKey() === name);
    if (i < 0) throw new Error("no such account " + name);
    this.active = i;
    this.save();
    return this.address();
  },
  address(i = this.active) {
    return this.accounts[i]?.kp.publicKey() ?? "";
  },
  isAllowed() {
    return this.allowed.includes(this.address());
  },
  byAddress(addr) {
    return this.accounts.find((a) => a.kp.publicKey() === addr);
  },
  list() {
    return this.accounts.map((a, i) => `${i === this.active ? "*" : " "} ${a.name}: ${a.kp.publicKey()}`).join("\n");
  },
  async fund(name) {
    const addr = this.select(name);
    const r = await fetch(`https://friendbot.stellar.org/?addr=${addr}`);
    return r.status;
  },
});

const passphrase = () => (ff.network === "TESTNET" ? Networks.TESTNET : Networks.PUBLIC);
const reply = (id, payload) =>
  window.postMessage({ source: RES, messagedId: id, ...payload }, window.location.origin);
const rejected = { apiError: { code: -4, message: "The user rejected this request." } };
const b64 = (u8) => btoa(String.fromCharCode(...u8));

// Like Freighter: sign as accountToSign if the wallet holds it (switching to it), else the active account.
function signer(accountToSign) {
  if (accountToSign && !ff.ignoreAccountToSign) {
    const a = ff.byAddress(accountToSign);
    if (!a) return null;
    ff.active = ff.accounts.indexOf(a);
    ff.save();
    return a;
  }
  return ff.accounts[ff.active];
}

window.freighter = true; // freighter-api's isConnected() short-circuits on this
window.addEventListener("message", async (event) => {
  if (event.source !== window || event.data?.source !== REQ) return;
  const { messageId: id, type, ...msg } = event.data;
  ff.counts[type] = (ff.counts[type] || 0) + 1;

  switch (type) {
    case "REQUEST_CONNECTION_STATUS":
      return reply(id, { isConnected: true });
    case "REQUEST_ALLOWED_STATUS":
      return reply(id, { isAllowed: ff.isAllowed() });
    case "SET_ALLOWED_STATUS":
    case "REQUEST_ACCESS":
      if (ff.rejectNext === "access") {
        ff.rejectNext = null;
        ff.requests.push({ type, rejected: true });
        return reply(id, rejected);
      }
      if (!ff.isAllowed()) ff.allowed.push(ff.address());
      ff.save();
      return reply(id, { publicKey: ff.address(), isAllowed: true });
    case "REQUEST_PUBLIC_KEY":
      return reply(id, { publicKey: ff.isAllowed() ? ff.address() : "" });
    case "REQUEST_NETWORK":
    case "REQUEST_NETWORK_DETAILS":
      return reply(id, {
        network: ff.network,
        networkPassphrase: passphrase(),
        networkDetails: {
          network: ff.network,
          networkName: ff.network,
          networkUrl: "https://horizon-testnet.stellar.org",
          networkPassphrase: passphrase(),
          sorobanRpcUrl: "https://soroban-testnet.stellar.org",
        },
      });
    case "SUBMIT_BLOB": {
      const entry = { type, accountToSign: msg.accountToSign, activeBefore: ff.address(), blob: msg.blob, networkPassphrase: msg.networkPassphrase };
      ff.requests.push(entry);
      if (ff.rejectNext === "message") {
        ff.rejectNext = null;
        entry.rejected = true;
        return reply(id, rejected);
      }
      const acct = signer(msg.accountToSign);
      if (!acct) {
        entry.error = "account not in wallet";
        return reply(id, { apiError: { code: -1, message: "The requested account is not in the wallet." } });
      }
      // SEP-53: ed25519 over sha256("Stellar Signed Message:\n" || utf8(message))
      const bytes = new TextEncoder().encode("Stellar Signed Message:\n" + msg.blob);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const sig = new Uint8Array(acct.kp.sign(digest));
      if (ff.corruptSignature) sig[0] ^= 1;
      entry.signedBy = acct.kp.publicKey();
      return reply(id, { signedBlob: b64(sig), signerAddress: acct.kp.publicKey() });
    }
    case "SUBMIT_TRANSACTION": {
      const entry = { type, accountToSign: msg.accountToSign, activeBefore: ff.address(), networkPassphrase: msg.networkPassphrase };
      ff.requests.push(entry);
      if (ff.rejectNext === "tx") {
        ff.rejectNext = null;
        entry.rejected = true;
        return reply(id, rejected);
      }
      const acct = signer(msg.accountToSign);
      if (!acct) {
        entry.error = "account not in wallet";
        return reply(id, { apiError: { code: -1, message: "The requested account is not in the wallet." } });
      }
      const tx = TransactionBuilder.fromXDR(msg.transactionXdr, msg.networkPassphrase || passphrase());
      entry.source = tx.source;
      entry.operations = tx.operations.map((o) => o.type + (o.func ? ":" + o.func.switch().name : ""));
      tx.sign(acct.kp);
      entry.signedBy = acct.kp.publicKey();
      return reply(id, { signedTransaction: tx.toXDR(), signerAddress: acct.kp.publicKey() });
    }
    default:
      return reply(id, { apiError: { code: -1, message: `fake Freighter: unsupported ${type}` } });
  }
});
return `fake Freighter ready, ${ff.accounts.length} account(s)`;
