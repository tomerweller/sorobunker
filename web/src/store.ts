/**
 * What this browser remembers. The vault itself only knows a key hash, so the app keeps
 * track of which wallet account is the current key, and which keys it has already used.
 */
export interface Store {
  feePayer?: string;
  vault?: string;
  vaults: Record<string, VaultRecord>;
}

export interface VaultRecord {
  currentKey?: string;
  usedKeys: string[];
  /** What this browser did with the vault, newest first. */
  activity?: Activity[];
}

export interface Activity {
  kind: "create" | "deposit" | "send" | "rotate";
  text: string;
  time: number;
  hash?: string;
}

const KEY = "sorobunker";

export function load(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (s && typeof s === "object" && s.vaults) return s;
  } catch {
    // Storage unavailable or corrupt: start fresh.
  }
  return { vaults: {} };
}

export function save(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not persisted; the app still works for this session.
  }
}

export function vaultKeys(s: Store, vault: string): VaultRecord {
  return (s.vaults[vault] ??= { usedKeys: [] });
}

export function addActivity(s: Store, vault: string, a: Omit<Activity, "time">) {
  const v = vaultKeys(s, vault);
  v.activity = [{ ...a, time: Date.now() }, ...(v.activity ?? [])].slice(0, 50);
  save(s);
}

/** Every vault key this browser has seen, for any vault. */
export function allKeys(s: Store): Set<string> {
  const keys = new Set<string>();
  for (const v of Object.values(s.vaults)) {
    if (v.currentKey) keys.add(v.currentKey);
    v.usedKeys.forEach((k) => keys.add(k));
  }
  return keys;
}
