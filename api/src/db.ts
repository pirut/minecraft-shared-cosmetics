export type CosmeticType = "HAT" | "TRAIL";

/** Each cosmetic type occupies exactly one equip slot. */
export const SLOT_FOR_TYPE: Record<CosmeticType, string> = {
  HAT: "head",
  TRAIL: "trail",
};

export interface Cosmetic {
  id: string;
  name: string;
  type: CosmeticType;
  slot: string;
  /** Players can add it to their account themselves from the web page. */
  claimable: boolean;
  /**
   * Render hints for the server plugin.
   * HAT:   { material: "BLACK_WOOL", kit?: { crown: "tall", brim: "wide", band: true, colors: ["#1c1c21", "#961a22"] } }
   *        or { material: "CARVED_PUMPKIN", itemModel?: "myns:custom_hat" } for a model outside the kit
   * TRAIL: { particle: "HEART", count?: 1 }
   */
  data: Record<string, unknown>;
}

export interface PlayerInfo {
  uuid: string;
  name: string;
}

export interface ServerInfo {
  id: string;
  name: string;
  createdAt: string;
  /** Set once the server is revoked; a revoked server's keys never work again. */
  revokedAt: string | null;
}

/**
 * Persistence for the API. Two implementations: SQLite for local runs and tests,
 * Postgres for hosted, multi-instance deployments.
 */
export interface Store {
  close(): Promise<void>;

  listCosmetics(): Promise<Cosmetic[]>;
  getCosmetic(id: string): Promise<Cosmetic | undefined>;
  upsertCosmetic(c: Omit<Cosmetic, "slot">): Promise<Cosmetic>;

  createServer(id: string, name: string, keyHash: string): Promise<void>;
  listServers(): Promise<ServerInfo[]>;
  /** Returns the server only if the key is current (or in its rotation grace period) and the server isn't revoked. */
  findServerByKeyHash(keyHash: string): Promise<{ id: string; name: string } | undefined>;
  /**
   * Adds a new key and makes every existing key expire after `graceMs` (0 = immediately).
   * Returns false if the server doesn't exist or is revoked.
   */
  rotateServerKey(id: string, newKeyHash: string, graceMs: number): Promise<boolean>;
  /** Permanently disables the server and all its keys. Returns false if it doesn't exist. */
  revokeServer(id: string): Promise<boolean>;

  /** Remembers the latest name a server or link code reported for a uuid. */
  seePlayer(uuid: string, name: string): Promise<void>;
  getPlayer(uuid: string): Promise<PlayerInfo | undefined>;
  /** Case-insensitive; the most recently seen player wins if a name changed hands. */
  findPlayerByName(name: string): Promise<PlayerInfo | undefined>;

  /** Stores a fresh link code for a player, replacing any earlier one. */
  createLinkCode(code: string, playerUuid: string, expiresAt: number): Promise<void>;
  /** Deletes the code and returns its player if it existed and had not expired. */
  consumeLinkCode(code: string): Promise<string | undefined>;
  createSession(tokenHash: string, playerUuid: string, expiresAt: number): Promise<void>;
  findSession(tokenHash: string): Promise<string | undefined>;
  deleteSession(tokenHash: string): Promise<void>;

  grant(playerUuid: string, cosmeticId: string): Promise<void>;
  /** Takes a cosmetic away, unequipping it first. */
  revoke(playerUuid: string, cosmeticId: string): Promise<void>;
  owns(playerUuid: string, cosmeticId: string): Promise<boolean>;
  ownedCosmetics(playerUuid: string): Promise<Cosmetic[]>;
  equipped(playerUuid: string): Promise<Record<string, string>>;
  equip(playerUuid: string, slot: string, cosmeticId: string): Promise<void>;
  unequip(playerUuid: string, slot: string): Promise<void>;
}

/** Postgres when `url` is a postgres:// URL, otherwise a SQLite file path (or ":memory:"). */
export async function openStore(url: string): Promise<Store> {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { PostgresStore } = await import("./postgres-store.ts");
    return PostgresStore.connect(url);
  }
  const { SqliteStore } = await import("./sqlite-store.ts");
  return new SqliteStore(url);
}

export interface CosmeticRow {
  id: string;
  name: string;
  type: CosmeticType;
  claimable: number | boolean;
  data: string | Record<string, unknown>;
}

export function toCosmetic(row: CosmeticRow): Cosmetic {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    slot: SLOT_FOR_TYPE[row.type],
    claimable: !!row.claimable,
    data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
  };
}
