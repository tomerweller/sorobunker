import "./style.css";
import { StrKey } from "@stellar/stellar-sdk";
import { server } from "./chain";
import { EXPLORER_CONTRACT, EXPLORER_TX, XLM_SAC } from "./config";
import { pkHash, transferRotateMessage } from "./message";
import { addActivity, allKeys, load, save, vaultKeys, type Activity } from "./store";
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
  type Stage,
  type TokenInfo,
  type VaultState,
} from "./vault";
import { connectFreighter, freighterAllowed, type Signer } from "./wallet";

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
  /** The fee payer's XLM, when it could be read. */
  feePayerXlm?: bigint;
}

/** The open sheet (a modal dialog) and its form. A transfer and a rotation share one flow. */
interface Sheet {
  kind: "send" | "rotate" | "deposit" | "vaults";
  step: "details" | "next" | "review" | "progress";
  to: string;
  amount: string;
  token: string;
  nextKey?: string;
  error?: string;
  /** Progress of a running transfer; undefined while the vault is being checked. */
  stage?: Stage;
  failed?: boolean;
  done?: boolean;
  hash?: string;
  /** The number of the key that signed, once a transfer started. */
  signedAs?: bigint;
  feePayerBalance?: bigint;
}

const store = load();
let signer: Signer | undefined;
let active: string | undefined;
let activeError: string | undefined;
let loaded: Loaded | undefined;
let loading = false;
let busy: string | undefined;
let sheet: Sheet | undefined;
let vaultInput = store.vault ?? "";

const $ = (id: string) => document.getElementById(id)!;
const sheetEl = $("sheet") as HTMLDialogElement;

// ---- small helpers ---------------------------------------------------------------------

const ICONS: Record<string, string> = {
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  external: '<path d="M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6M11 13l9-9M15 4h5v5"/>',
  send: '<path d="M7 17L17 7M8 7h9v9"/>',
  deposit: '<path d="M17 7L7 17M16 17H7V8"/>',
  rotate: '<path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4"/>',
  shield: '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  vault: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5V7M12 17v-1.5M15.5 12H17M7 12h1.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
const icon = (name: string) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const spinner = '<span class="spinner" aria-hidden="true"></span>';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** A shortened address with its full value on hover and a copy button. */
const addr = (a: string) =>
  `<span class="addr"><span class="mono" title="${esc(a)}">${short(a)}</span><button class="icon-btn" data-copy="${esc(a)}" aria-label="Copy ${esc(a)}">${icon("copy")}</button></span>`;

const link = (href: string, label: string) =>
  `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} ${icon("external")}</a>`;

const notice = (kind: "ok" | "bad" | "warn" | "info", html: string) =>
  `<div class="notice ${kind}">${icon(kind === "ok" ? "check" : kind === "info" ? "shield" : "alert")}<div>${html}</div></div>`;

const amountText = (n: bigint, info = loaded!.info) => `${formatAmount(n, info.decimals)} ${info.symbol}`;

/** The wallet kit rejects with plain `{ code, message }` objects rather than Errors. */
function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : (e as { message?: string })?.message;
  if (message === "Freighter is not connected") {
    return "Freighter was not found. Install the extension, unlock it, and try again.";
  }
  return message ?? JSON.stringify(e);
}

function toast(html: string, kind: "ok" | "bad" | "info" = "info") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.innerHTML = `${icon(kind === "ok" ? "check" : kind === "bad" ? "alert" : "shield")}<div>${html}</div><button class="icon-btn" aria-label="Dismiss">${icon("x")}</button>`;
  t.querySelector("button")!.onclick = () => t.remove();
  $("toasts").append(t);
  if (kind !== "bad") setTimeout(() => t.remove(), 5000);
}

const currentKey = () => (loaded ? vaultKeys(store, loaded.vault).currentKey : undefined);
const currentKeyMatches = () => {
  const key = currentKey();
  return !!(loaded && key && pkHash(key).equals(loaded.state.pkHash));
};
/** Key n signs at nonce n-1. */
const currentKeyNumber = () => (loaded ? loaded.state.nonce + 1n : 1n);
/** The next key chosen in an unfinished transfer, if any. */
const pendingNextKey = () => (sheet && !sheet.done ? sheet.nextKey : undefined);

/** What the given account already is to this app. */
function roleOf(a: string): string | undefined {
  if (a === store.feePayer) return "Fee payer";
  if (a === currentKey()) return `Current key #${currentKeyNumber()}`;
  if (a === pendingNextKey()) return `Next key #${currentKeyNumber() + 1n}`;
  if (allKeys(store).has(a)) return "Used vault key";
  return undefined;
}

/** Whether Freighter's active account can take a role; says why not when it can't. */
function activeCheck(purpose: "fee payer" | "key"): { ok: boolean; text: string } {
  if (!signer) return { ok: false, text: "Connect Freighter first." };
  if (activeError) return { ok: false, text: activeError };
  if (!active) return { ok: false, text: "Select an account in Freighter." };
  const who = `<span class="mono">${short(active)}</span>`;
  if (purpose === "fee payer") {
    if (allKeys(store).has(active)) {
      return { ok: false, text: `${who} is a vault key. Select an ordinary funded account in Freighter.` };
    }
    if (active === store.feePayer) return { ok: true, text: `${who} is already the fee payer.` };
    return { ok: true, text: `Freighter's active account is ${who}.` };
  }
  if (active === store.feePayer) {
    return { ok: false, text: `${who} is the fee payer. Add a new account in Freighter and select it.` };
  }
  if (active === currentKey()) {
    return { ok: false, text: `${who} is the vault's current key. Add a new account in Freighter and select it.` };
  }
  if (allKeys(store).has(active)) {
    return { ok: false, text: `${who} was already used as a vault key. Add a new account in Freighter.` };
  }
  return { ok: true, text: `${who} is a new account, ready to use.` };
}

const checkHtml = (c: { ok: boolean; text: string }) => notice(c.ok ? "ok" : "warn", c.text);

// ---- rendering -------------------------------------------------------------------------

const lastHtml = new WeakMap<Element, string>();

/** Replace an element's content only when it changed, keeping focus and the caret. */
function patch(el: HTMLElement, html: string) {
  if (lastHtml.get(el) === html) return;
  lastHtml.set(el, html);
  const focused = document.activeElement as HTMLInputElement | null;
  const id = focused && el.contains(focused) ? focused.id : "";
  const caret = id && focused?.selectionStart != null ? [focused.selectionStart, focused.selectionEnd] : undefined;
  el.innerHTML = html;
  const again = id ? (document.getElementById(id) as HTMLInputElement | null) : null;
  if (again) {
    again.focus();
    if (caret) again.setSelectionRange(caret[0], caret[1]);
  }
}

function render() {
  patch($("wallet"), walletHtml());
  patch($("main"), loaded ? dashboardHtml() : loading ? loadingHtml() : setupHtml());
  if (sheet) {
    patch(sheetEl, sheetHtml(sheet));
    if (!sheetEl.open) sheetEl.showModal();
  } else if (sheetEl.open) {
    sheetEl.close();
  }
}

function walletHtml(): string {
  if (!signer) {
    return `<button data-action="connect" id="connect">${busy === "connect" ? `${spinner} Connecting…` : "Connect Freighter"}</button>`;
  }
  if (activeError || !active) {
    return `<span class="chip warn">${icon("alert")} ${esc(activeError ?? "No account selected")}</span>`;
  }
  const role = roleOf(active);
  return `<span class="chip" title="Freighter's active account: ${esc(active)}"><span class="dot"></span><span class="mono">${short(active)}</span>${role ? `<span class="chip-role">${esc(role)}</span>` : ""}</span>`;
}

const loadingHtml = () => `<section class="card loading">${spinner} Loading vault…</section>`;

function setupHtml(): string {
  const step = (n: number, title: string, done: boolean, body: string) => `
    <li class="step ${done ? "done" : ""}">
      <span class="step-num">${done ? icon("check") : n}</span>
      <div class="step-body"><h3>${title}</h3>${body}</div>
    </li>`;

  const connected = signer
    ? `<p>Connected. Freighter's active account is ${active ? addr(active) : "not available"}.</p>`
    : `<p class="muted">Set Freighter to Testnet, then connect. Every key SoroBunker uses is a Freighter account.</p>
       <button class="primary" data-action="connect">${busy === "connect" ? `${spinner} Connecting…` : "Connect Freighter"}</button>`;

  const feePayer = store.feePayer
    ? `<p>${addr(store.feePayer)} pays for transactions.</p>${feePayerSwap()}`
    : `<p class="muted">An ordinary funded account. It submits and pays for transactions, but can't move vault funds. It must never be a vault key.</p>
       ${signer ? checkHtml(activeCheck("fee payer")) : ""}
       <button class="primary" data-action="use-fee-payer" ${signer ? "" : "hidden"}>Use ${active ? `<span class="mono">${short(active)}</span>` : "active account"} as fee payer</button>`;

  return `
    <section class="intro">
      <h1>A vault with one-time keys</h1>
      <p>A SoroBunker vault stores only the hash of its key. Each transfer reveals that key once, then replaces it with a new hidden one.</p>
    </section>
    <ol class="setup card">
      ${step(1, "Connect Freighter", !!signer, connected)}
      ${step(2, "Choose a fee payer", !!store.feePayer, feePayer)}
      ${step(3, "Open a vault", false, openVaultHtml())}
    </ol>`;
}

/** Offer the active account as fee payer when it differs and could be one. */
function feePayerSwap(): string {
  if (!active || active === store.feePayer || allKeys(store).has(active)) return "";
  return `<button class="link" data-action="use-fee-payer">Use <span class="mono">${short(active)}</span> instead</button>`;
}

/** Create a new vault, or open one by address. Shared by setup and the vaults sheet. */
function openVaultHtml(): string {
  const known = Object.keys(store.vaults).filter((v) => v !== loaded?.vault);
  const ready = !!signer && !!store.feePayer;
  return `
    <div class="split">
      <div class="option">
        <h4>Create a new vault</h4>
        <p class="muted">In Freighter, add a new account named <code>SoroBunker key 1 (do not fund)</code> and select it. It becomes the vault's first key.</p>
        ${ready ? checkHtml(activeCheck("key")) : notice("info", "Connect Freighter and choose a fee payer first.")}
        <button class="${ready ? "primary" : ""}" data-action="create-vault">${busy === "create" ? `${spinner} Creating…` : `${icon("plus")} Create vault`}</button>
      </div>
      <div class="option">
        <h4>Open an existing vault</h4>
        <div class="row">
          <input id="vault-input" data-field="vaultInput" class="mono" placeholder="C… vault address" spellcheck="false" autocomplete="off" value="${esc(vaultInput)}" />
          <button data-action="open-vault">${busy === "open" ? spinner : "Open"}</button>
        </div>
        ${
          known.length
            ? `<p class="muted small">Recent</p><ul class="known">${known
                .map((v) => `<li><button class="link mono" data-action="open-vault" data-arg="${esc(v)}">${short(v)}</button></li>`)
                .join("")}</ul>`
            : ""
        }
      </div>
    </div>`;
}

function dashboardHtml(): string {
  const { vault, state, info } = loaded!;
  const n = currentKeyNumber();
  const key = currentKey();
  const status = currentKeyMatches()
    ? `<span class="pill ok">${icon("shield")} Key #${n} is hidden. Only its hash is on-chain.</span>`
    : `<div class="recover">${notice(
        "warn",
        `This browser doesn't know which Freighter account is key #${n}. Select it in Freighter, then
         <button class="link" data-action="recover">use the active account as the current key</button>.`,
      )}</div>`;

  const roleCard = (title: string, who: string | undefined, empty: string, sub: string, cls = "", extra = "") => `
    <div class="role ${cls}">
      <div class="role-title">${title}${who && who === active ? `<span class="tag">Active in Freighter</span>` : ""}</div>
      <div class="role-addr">${who ? addr(who) : `<span class="muted">${empty}</span>`}</div>
      <div class="muted small">${sub}</div>${extra}
    </div>`;

  const next = pendingNextKey();
  const revealed = state.nonce === 0n ? "" : state.nonce === 1n ? "#1" : `#1 to #${state.nonce}`;
  const activity = vaultKeys(store, vault).activity ?? [];

  return `
    <section class="card hero">
      <div class="hero-top">
        <span class="muted">Vault</span> ${addr(vault)}
        ${link(EXPLORER_CONTRACT + vault, "Explorer")}
        <button class="link push" data-action="open-vaults">Switch vault</button>
      </div>
      <div class="balance">${esc(formatAmount(loaded!.balance, info.decimals))}<span>${esc(info.symbol)}</span></div>
      ${status}
      <div class="actions">
        <button class="primary" data-action="open-send">${icon("send")} Send</button>
        <button data-action="open-deposit">${icon("deposit")} Deposit</button>
      </div>
    </section>

    <section class="roles" aria-label="Accounts">
      ${roleCard(
        "Fee payer",
        store.feePayer,
        "Not set",
        // XLM to two decimal places is enough to see whether fees are covered.
        loaded!.feePayerXlm !== undefined ? `${formatAmount(loaded!.feePayerXlm - (loaded!.feePayerXlm % 100000n), 7)} XLM · pays fees` : "Pays fees, can't move funds",
        "",
        store.feePayer ? feePayerSwap() : `<button class="link" data-action="use-fee-payer">Use active account</button>`,
      )}
      ${roleCard(`Current key #${n}`, currentKeyMatches() ? key : undefined, "Unknown", "Signs the next transfer", "current")}
      ${roleCard(`Next key #${n + 1n}`, next, "Not chosen yet", next ? "Only its hash goes on-chain" : "Chosen when you send", "next")}
      <div class="chain" aria-label="Key chain">
        <span class="muted small">Key chain</span>
        ${revealed ? `<span class="link-pill used">${revealed} revealed</span>${icon("arrow")}` : ""}
        <span class="link-pill current">#${n} current</span>${icon("arrow")}
        <span class="link-pill next">#${n + 1n} next</span>
      </div>
    </section>

    <section class="card">
      <h2>Activity</h2>
      ${
        activity.length
          ? `<ul class="activity">${activity.map(activityHtml).join("")}</ul>`
          : `<p class="muted">Transfers and deposits you make from this browser show up here.</p>`
      }
    </section>`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(t: number): string {
  const s = (t - Date.now()) / 1000;
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  }
  return "just now";
}

function activityHtml(a: Activity): string {
  const iconName = { create: "plus", deposit: "deposit", send: "send", rotate: "rotate" }[a.kind];
  return `<li>
    <span class="act-icon ${a.kind}">${icon(iconName)}</span>
    <span class="act-text">${esc(a.text)}</span>
    <span class="muted small">${ago(a.time)}</span>
    ${a.hash ? `<a class="icon-btn" href="${EXPLORER_TX + a.hash}" target="_blank" rel="noopener" aria-label="View transaction">${icon("external")}</a>` : ""}
  </li>`;
}

// ---- sheets ----------------------------------------------------------------------------

function sheetHtml(s: Sheet): string {
  const titles = { send: "Send", rotate: "Rotate key", deposit: "Deposit", vaults: "Vaults" };
  const closable = !busy;
  const head = `<div class="sheet-head"><h2 id="sheet-title">${titles[s.kind]}</h2>
    <button class="icon-btn" data-action="close-sheet" aria-label="Close" ${closable ? "" : "hidden"}>${icon("x")}</button></div>`;
  const error = s.error && s.step !== "progress" ? notice("bad", esc(s.error)) : "";
  if (s.kind === "deposit") return head + depositHtml(s) + error;
  if (s.kind === "vaults") return head + vaultsHtml() + error;
  return head + stepperHtml(s) + transferStepHtml(s, error);
}

function stepperHtml(s: Sheet): string {
  const steps = (s.kind === "send" ? ["details", "next", "review", "progress"] : ["next", "review", "progress"]) as Sheet["step"][];
  const labels = { details: "Details", next: "Next key", review: "Review", progress: s.kind === "send" ? "Send" : "Rotate" };
  const at = steps.indexOf(s.step);
  return `<ol class="stepper">${steps
    .map((st, i) => {
      const state = i < at || (st === "progress" && s.done) ? "done" : i === at ? "now" : "";
      return `<li class="${state}"><span>${state === "done" ? icon("check") : i + 1}</span>${labels[st]}</li>`;
    })
    .join("")}</ol>`;
}

function transferStepHtml(s: Sheet, error: string): string {
  const { info } = loaded!;
  const n = currentKeyNumber();
  const footer = (back: string, primary: string) => `<div class="sheet-foot">${back}${primary}</div>`;
  const backBtn = (label = "Back") => `<button data-action="back">${label}</button>`;

  if (s.step === "details") {
    return `
      <label for="to">To</label>
      <input id="to" data-field="to" class="mono" placeholder="G… or C… address" spellcheck="false" autocomplete="off" value="${esc(s.to)}" />
      <div class="label-row"><label for="amount">Amount</label><span class="muted small">Available ${esc(amountText(loaded!.balance))} · <button class="link" data-action="max">Max</button></span></div>
      <div class="amount-field"><input id="amount" data-field="amount" inputmode="decimal" placeholder="0" autocomplete="off" value="${esc(s.amount)}" /><span>${esc(info.symbol)}</span></div>
      <details class="advanced" ${s.token !== XLM_SAC ? "open" : ""}>
        <summary>Token</summary>
        <input id="token" data-field="token" class="mono" spellcheck="false" value="${esc(s.token)}" />
        <p class="muted small">Any SEP-41 token contract. Defaults to native XLM.</p>
      </details>
      ${error}
      ${footer(`<button data-action="close-sheet">Cancel</button>`, `<button class="primary" data-action="details-continue">${busy === "token" ? spinner : "Continue"}</button>`)}`;
  }

  if (s.step === "next") {
    const name = `SoroBunker key ${n + 1n} (do not fund)`;
    const check = activeCheck("key");
    const chosen = s.nextKey
      ? notice("ok", `Key #${n + 1n} is <span class="mono">${short(s.nextKey)}</span>. Only its hash will go on-chain.`)
      : checkHtml(check);
    const swap = s.nextKey && active && active !== s.nextKey && check.ok
      ? `<button class="link" data-action="use-next">Use <span class="mono">${short(active)}</span> instead</button>`
      : "";
    // Freighter's active account is polled, so the button appears once a usable one is selected.
    const primary = s.nextKey
      ? `<button class="primary" data-action="next-continue">Continue</button>`
      : check.ok
        ? `<button class="primary" data-action="use-next">${busy === "next" ? `${spinner} Checking…` : `Use <span class="mono">${short(active!)}</span> as next key`}</button>`
        : `<span class="waiting muted small">${spinner} Waiting for a new account in Freighter</span>`;
    return `
      <p class="muted">${s.kind === "rotate" ? "Rotating moves no funds. It" : "Every transfer"} retires key #${n} and commits to a new key. Choose it now:</p>
      <ol class="howto">
        <li>In Freighter, add a new account named <code>${esc(name)}</code> <button class="icon-btn" data-copy="${esc(name)}" aria-label="Copy name">${icon("copy")}</button></li>
        <li>Keep it selected. SoroBunker checks it below.</li>
        <li>Never fund it or share its address: in Stellar, an address is its public key.</li>
      </ol>
      ${chosen}${swap}
      ${error}
      ${footer(s.kind === "send" ? backBtn() : `<button data-action="close-sheet">Cancel</button>`, primary)}`;
  }

  if (s.step === "review") {
    const amount = parseAmount(s.amount || "0", info.decimals);
    const message = transferRotateMessage({
      vault: loaded!.vault,
      nonce: loaded!.state.nonce,
      token: loaded!.token,
      to: s.to,
      amount,
      nextPkHash: pkHash(s.nextKey!),
    });
    const lines = message
      .split("\n")
      .map((line) => {
        const hot = /^(to|amount|next key hash): /.test(line);
        const [k, ...v] = line.split(": ");
        return v.length
          ? `<div class="${hot ? "hot" : ""}"><span class="k">${esc(k)}:</span> ${esc(v.join(": "))}</div>`
          : `<div class="k">${esc(line)}</div>`;
      })
      .join("");
    const row = (k: string, v: string) => `<dt>${k}</dt><dd>${v}</dd>`;
    return `
      <dl class="summary">
        ${row("Send", amount === 0n ? `<span class="muted">Nothing, key rotation only</span>` : `<strong>${esc(amountText(amount))}</strong>`)}
        ${s.kind === "send" ? row("To", addr(s.to)) : ""}
        ${row("Signed by", `Key #${n} · ${addr(currentKey()!)}`)}
        ${row("Next key", `Key #${n + 1n} · ${addr(s.nextKey!)}`)}
        ${row("Fees paid by", addr(store.feePayer!))}
      </dl>
      <p class="muted small">Freighter will show key #${n} this exact message. Check the highlighted lines.</p>
      <div class="message mono">${lines}</div>
      <p class="muted small">${amount > 0n ? `The amount is in base units: ${amount} = ${esc(amountText(amount))}. ` : ""}SoroBunker checks the signature and simulates the transfer before anything is broadcast.</p>
      ${error}
      ${footer(backBtn(), `<button class="primary" data-action="sign">Sign with key #${n}</button>`)}`;
  }

  // progress
  const k = s.signedAs ?? n;
  const order: Stage[] = ["sign", "simulate", "submit", "confirm"];
  const labels: Record<Stage, string> = {
    sign: `Key #${k} signs the message in Freighter`,
    simulate: "Check the signature and simulate",
    submit: "Fee payer signs the transaction in Freighter",
    confirm: "Confirm on testnet",
  };
  const at = s.done ? order.length : s.stage ? order.indexOf(s.stage) : 0;
  const list = order
    .map((st, i) => {
      const state = i < at ? "done" : i === at ? (s.failed ? "failed" : "now") : "";
      const mark = state === "done" ? icon("check") : state === "failed" ? icon("x") : state === "now" ? spinner : "";
      return `<li class="${state}"><span class="mark">${mark}</span>${labels[st]}</li>`;
    })
    .join("");

  let tail = "";
  if (s.done) {
    const sent = parseAmount(s.amount || "0", info.decimals);
    tail = `
      <div class="success">
        <div class="success-icon">${icon("check")}</div>
        <h3>${sent > 0n ? `Sent ${esc(amountText(sent))}` : "Key rotated"}</h3>
        <p class="muted">Key #${k} is retired. Key #${k + 1n} is now hidden behind its hash.</p>
        ${link(EXPLORER_TX + s.hash!, "View transaction")}
      </div>
      ${footer("", `<button class="primary" data-action="close-sheet">Done</button>`)}`;
  } else if (s.failed) {
    const exposed = s.stage === "confirm";
    tail = `
      ${notice("bad", esc(s.error ?? "Something went wrong."))}
      ${exposed ? notice("warn", `The transaction was broadcast, so key #${k}'s public key may now be on-chain. Rotate to a new key right away.`) : ""}
      ${footer(`<button data-action="close-sheet">Close</button>`, exposed ? `<button class="primary" data-action="rotate-now">Rotate now</button>` : `<button class="primary" data-action="back">Back to review</button>`)}`;
  } else {
    tail = `<p class="muted small">Approve each request in Freighter. Keep this window open.</p>`;
  }
  return `<ol class="progress">${list}</ol>${tail}`;
}

function depositHtml(s: Sheet): string {
  const { info } = loaded!;
  const from = store.feePayer
    ? `From the fee payer ${addr(store.feePayer)}${s.feePayerBalance !== undefined ? `, which holds ${esc(amountText(s.feePayerBalance))}` : ""}.`
    : "Choose a fee payer first.";
  return `
    <p class="muted">${from} Anyone can deposit by sending ${esc(info.symbol)} to the vault's address.</p>
    <label for="dep-amount">Amount</label>
    <div class="amount-field"><input id="dep-amount" data-field="amount" inputmode="decimal" placeholder="0" autocomplete="off" value="${esc(s.amount)}" /><span>${esc(info.symbol)}</span></div>
    <div class="sheet-foot"><button data-action="close-sheet" ${busy ? "hidden" : ""}>Cancel</button>
      <button class="primary" data-action="deposit">${busy === "deposit" ? `${spinner} Depositing…` : "Deposit"}</button></div>`;
}

const vaultsHtml = () =>
  `<p class="muted">Open ${loaded ? "another" : "a"} vault, or create a new one.</p>${openVaultHtml()}`;

// ---- actions ---------------------------------------------------------------------------

/**
 * Run one user action at a time. Errors show in the open sheet, or as a toast when none is
 * open, instead of being thrown.
 */
async function run(label: string, fn: () => Promise<void>) {
  if (busy) return;
  busy = label;
  if (sheet) sheet.error = undefined;
  render();
  try {
    await fn();
  } catch (e) {
    if (sheet) sheet.error = errorText(e);
    else toast(esc(errorText(e)), "bad");
  } finally {
    busy = undefined;
    render();
  }
}

/** Read a vault and token; only replaces what is shown once every read has succeeded. */
async function refresh(vault: string, token: string) {
  const state = await vaultState(vault);
  const info = await tokenInfo(token);
  const bal = await balance(token, vault);
  const feePayerXlm = store.feePayer ? await balance(XLM_SAC, store.feePayer).catch(() => undefined) : undefined;
  loaded = { vault, state, token, info, balance: bal, feePayerXlm };
}

async function connect() {
  // Only keep the signer once connecting fully succeeded, so a failure can be retried.
  const s = await connectFreighter();
  active = await s.activeAddress();
  signer = s;
  // Freighter has no change event through the kit, so poll the active account.
  setInterval(async () => {
    if (busy || !signer) return;
    try {
      const a = await signer.activeAddress();
      activeError = undefined;
      active = a;
    } catch (e) {
      activeError = errorText(e);
    }
    render();
  }, 1500);
}

async function openVault(v: string) {
  v = v.trim();
  if (!StrKey.isValidContract(v)) throw new Error("Enter a vault contract address (C…).");
  await refresh(v, loaded?.vault === v ? loaded.token : XLM_SAC);
  store.vault = v;
  save(store);
  vaultInput = v;
  sheet = undefined;
}

async function useFeePayer() {
  const c = activeCheck("fee payer");
  if (!c.ok) throw new Error(c.text.replace(/<[^>]+>/g, ""));
  // Vault keys are never funded, so this also keeps a fresh key from becoming the fee payer.
  await server.getAccount(active!).catch(() => {
    throw new Error(`${short(active!)} isn't funded, so it can't pay fees. Select a funded account in Freighter.`);
  });
  store.feePayer = active;
  save(store);
  toast(`Fee payer set to <span class="mono">${short(active!)}</span>.`, "ok");
}

async function create() {
  if (!signer) throw new Error("Connect Freighter first.");
  if (!store.feePayer) throw new Error("Choose a fee payer first.");
  const c = activeCheck("key");
  if (!c.ok) throw new Error(c.text.replace(/<[^>]+>/g, ""));
  const firstKey = active!;
  const { hash, vault } = await createVault(signer, store.feePayer, firstKey);
  vaultKeys(store, vault).currentKey = firstKey;
  store.vault = vault;
  vaultInput = vault;
  addActivity(store, vault, { kind: "create", text: `Created the vault with key #1`, hash });
  sheet = undefined;
  await refresh(vault, XLM_SAC);
  toast("Vault created. Deposit some XLM to get started.", "ok");
}

function recover() {
  if (!active || !loaded) throw new Error("Select the vault's current key in Freighter.");
  if (!pkHash(active).equals(loaded.state.pkHash)) {
    throw new Error(`${short(active)} is not this vault's current key: its hash doesn't match.`);
  }
  vaultKeys(store, loaded.vault).currentKey = active;
  save(store);
  toast(`Key #${currentKeyNumber()} found.`, "ok");
}

function openTransfer(kind: "send" | "rotate") {
  if (!signer) throw new Error("Connect Freighter first.");
  if (!store.feePayer) throw new Error("Choose a fee payer first.");
  if (!currentKeyMatches()) throw new Error(`Find key #${currentKeyNumber()} first: select it in Freighter and use it as the current key.`);
  sheet = {
    kind,
    step: kind === "send" ? "details" : "next",
    // A rotation is a zero-amount transfer; the fee payer is a safe recipient.
    to: kind === "rotate" ? store.feePayer : "",
    amount: kind === "rotate" ? "0" : "",
    token: loaded!.token,
  };
}

/** Why the transfer details can't be used yet, if they can't. */
function detailsError(s: Sheet): string | undefined {
  const to = s.to.trim();
  if (!to) return "Enter the recipient.";
  if (!StrKey.isValidEd25519PublicKey(to) && !StrKey.isValidContract(to)) {
    return "The recipient must be a G… account or C… contract address.";
  }
  if (to === currentKey() || to === s.nextKey || allKeys(store).has(to)) {
    return "Never send funds to a vault key: that puts it on-chain.";
  }
  let amount: bigint;
  try {
    amount = parseAmount(s.amount || "0", loaded!.info.decimals);
  } catch (e) {
    return errorText(e);
  }
  if (amount > loaded!.balance) return `The vault holds only ${amountText(loaded!.balance)}.`;
  return undefined;
}

async function useNext(s: Sheet) {
  const c = activeCheck("key");
  if (!c.ok) throw new Error(c.text.replace(/<[^>]+>/g, ""));
  const key = active!;
  if (key === s.to.trim()) throw new Error("The next key can't be the recipient.");
  if (await isKeyUsed(loaded!.vault, key)) {
    throw new Error("This vault already revealed that key, so it can never be its key again.");
  }
  s.nextKey = key;
}

async function sign(s: Sheet) {
  if (!signer || !store.feePayer || !currentKeyMatches() || !s.nextKey) return;
  const { vault, token, info } = loaded!;
  const keys = vaultKeys(store, vault);
  const amount = parseAmount(s.amount || "0", info.decimals);
  Object.assign(s, { step: "progress", stage: undefined, failed: false, error: undefined, signedAs: currentKeyNumber() });
  busy = "sign";
  render();
  try {
    const { hash } = await transferRotate(
      signer,
      { vault, feePayer: store.feePayer, currentKey: keys.currentKey!, nextKey: s.nextKey, token, to: s.to.trim(), amount },
      (stage) => {
        s.stage = stage;
        render();
      },
    );
    keys.usedKeys.push(keys.currentKey!);
    keys.currentKey = s.nextKey;
    const n = s.signedAs!;
    addActivity(store, vault, {
      kind: s.kind === "send" && amount > 0n ? "send" : "rotate",
      text: amount > 0n
        ? `Sent ${amountText(amount, info)} to ${short(s.to.trim())} · key #${n} → #${n + 1n}`
        : `Rotated key #${n} → #${n + 1n}`,
      hash,
    });
    Object.assign(s, { done: true, hash });
    await refresh(vault, token).catch(() => {});
  } catch (e) {
    s.failed = true;
    s.error = errorText(e);
  } finally {
    busy = undefined;
    render();
  }
}

const actions: Record<string, (arg?: string) => void> = {
  connect: () => run("connect", connect),
  "use-fee-payer": () => run("fee", useFeePayer),
  "create-vault": () => run("create", create),
  "open-vault": (arg) => run("open", () => openVault(arg ?? vaultInput)),
  recover: () => run("recover", async () => recover()),
  "open-send": () => run("sheet", async () => openTransfer("send")),
  "open-deposit": () =>
    run("sheet", async () => {
      if (!signer) throw new Error("Connect Freighter first.");
      if (!store.feePayer) throw new Error("Choose a fee payer first.");
      const s: Sheet = (sheet = { kind: "deposit", step: "details", to: "", amount: "", token: loaded!.token });
      balance(loaded!.token, store.feePayer).then((b) => {
        s.feePayerBalance = b;
        render();
      }, () => {});
    }),
  "open-vaults": () => {
    vaultInput = "";
    sheet = { kind: "vaults", step: "details", to: "", amount: "", token: XLM_SAC };
    render();
  },
  "close-sheet": () => {
    if (busy) return;
    sheet = undefined;
    render();
  },
  max: () => {
    sheet!.amount = formatAmount(loaded!.balance, loaded!.info.decimals);
    render();
  },
  "details-continue": () =>
    run("token", async () => {
      const s = sheet!;
      if (s.token.trim() !== loaded!.token) {
        await refresh(loaded!.vault, s.token.trim()).catch((e) => {
          s.token = loaded!.token; // keep the field in step with what is shown
          throw e;
        });
      }
      const err = detailsError(s);
      if (err) throw new Error(err);
      s.step = "next";
    }),
  "use-next": () => run("next", () => useNext(sheet!)),
  "next-continue": () => {
    const s = sheet!;
    const err = s.kind === "send" ? detailsError(s) : undefined;
    if (err) {
      s.error = err;
    } else {
      s.error = undefined;
      s.step = "review";
    }
    render();
  },
  back: () => {
    const s = sheet!;
    s.error = undefined;
    s.step = s.step === "progress" ? "review" : s.step === "review" ? "next" : "details";
    render();
  },
  sign: () => void sign(sheet!),
  "rotate-now": () => {
    sheet = undefined;
    run("sheet", async () => openTransfer("rotate"));
  },
  deposit: () =>
    run("deposit", async () => {
      const { vault, token, info } = loaded!;
      const amount = parseAmount(sheet!.amount, info.decimals);
      const { hash } = await deposit(signer!, store.feePayer!, vault, token, amount);
      addActivity(store, vault, { kind: "deposit", text: `Deposited ${amountText(amount, info)}`, hash });
      sheet = undefined;
      await refresh(vault, token);
      toast(`Deposited ${esc(amountText(amount, info))}.`, "ok");
    }),
};

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const copy = target.closest<HTMLElement>("[data-copy]");
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.copy!).then(() => toast("Copied.", "ok"), () => {});
    return;
  }
  const el = target.closest<HTMLElement>("[data-action]");
  if (el) actions[el.dataset.action!]?.(el.dataset.arg);
});

document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  const field = el.dataset.field;
  if (!field) return;
  if (field === "vaultInput") vaultInput = el.value;
  else if (sheet) (sheet as unknown as Record<string, string>)[field] = el.value;
  if (sheet) sheet.error = undefined;
  render();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const el = e.target as HTMLElement;
  if (el.id === "vault-input") actions["open-vault"]();
  else if (sheet?.step === "details" && el.tagName === "INPUT") actions[sheet.kind === "deposit" ? "deposit" : "details-continue"]();
});

// Escape and clicks on the backdrop close the sheet, unless an action is running.
sheetEl.addEventListener("cancel", (e) => {
  e.preventDefault();
  actions["close-sheet"]();
});
sheetEl.addEventListener("click", (e) => {
  // The dialog element itself is the target both for its padding and for the backdrop.
  const r = sheetEl.getBoundingClientRect();
  const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (e.target === sheetEl && outside) actions["close-sheet"]();
});

render();
(async () => {
  if (store.vault) {
    loading = true;
    render();
    try {
      await openVault(store.vault);
    } catch (e) {
      toast(`Couldn't load the last vault: ${esc(errorText(e))}`, "bad");
    }
    loading = false;
    render();
  }
  // Reconnect without a prompt if Freighter already allows this site.
  if ((await freighterAllowed()) && !signer) await run("connect", connect);
})();
