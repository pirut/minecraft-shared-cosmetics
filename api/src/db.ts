import { DatabaseSync } from "node:sqlite";

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cosmetics (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ownership (
  player_uuid TEXT NOT NULL,
  cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id),
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (player_uuid, cosmetic_id)
);
CREATE TABLE IF NOT EXISTS players (
  uuid      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS players_name ON players (name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS link_codes (
  code        TEXT PRIMARY KEY,
  player_uuid TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash  TEXT PRIMARY KEY,
  player_uuid TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS equipped (
  player_uuid TEXT NOT NULL,
  slot        TEXT NOT NULL,
  cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id),
  PRIMARY KEY (player_uuid, slot)
);
`;

interface CosmeticRow {
  id: string;
  name: string;
  type: CosmeticType;
  claimable: number;
  data: string;
}

export interface PlayerInfo {
  uuid: string;
  name: string;
}

function toCosmetic(row: CosmeticRow): Cosmetic {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    slot: SLOT_FOR_TYPE[row.type],
    claimable: !!row.claimable,
    data: JSON.parse(row.data),
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    const columns = this.db.prepare("PRAGMA table_info(cosmetics)").all() as unknown as { name: string }[];
    if (!columns.some((c) => c.name === "claimable")) {
      this.db.exec("ALTER TABLE cosmetics ADD COLUMN claimable INTEGER NOT NULL DEFAULT 0");
    }
  }

  close(): void {
    this.db.close();
  }

  listCosmetics(): Cosmetic[] {
    const rows = this.db.prepare("SELECT id, name, type, claimable, data FROM cosmetics ORDER BY id").all();
    return (rows as unknown as CosmeticRow[]).map(toCosmetic);
  }

  getCosmetic(id: string): Cosmetic | undefined {
    const row = this.db.prepare("SELECT id, name, type, claimable, data FROM cosmetics WHERE id = ?").get(id);
    return row ? toCosmetic(row as unknown as CosmeticRow) : undefined;
  }

  upsertCosmetic(c: Omit<Cosmetic, "slot">): Cosmetic {
    this.db
      .prepare(
        `INSERT INTO cosmetics (id, name, type, claimable, data, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type,
           claimable = excluded.claimable, data = excluded.data`,
      )
      .run(c.id, c.name, c.type, c.claimable ? 1 : 0, JSON.stringify(c.data), Date.now());
    return this.getCosmetic(c.id)!;
  }

  createServer(id: string, name: string, keyHash: string): void {
    this.db
      .prepare("INSERT INTO servers (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, keyHash, Date.now());
  }

  findServerByKeyHash(keyHash: string): { id: string; name: string } | undefined {
    const row = this.db.prepare("SELECT id, name FROM servers WHERE key_hash = ?").get(keyHash);
    return row as { id: string; name: string } | undefined;
  }

  listServers(): { id: string; name: string; createdAt: number }[] {
    return this.db
      .prepare("SELECT id, name, created_at AS createdAt FROM servers ORDER BY created_at")
      .all() as unknown as { id: string; name: string; createdAt: number }[];
  }

  /** Remembers the latest name a server or link code reported for a uuid. */
  seePlayer(uuid: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO players (uuid, name, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
      )
      .run(uuid, name, Date.now());
  }

  getPlayer(uuid: string): PlayerInfo | undefined {
    return this.db.prepare("SELECT uuid, name FROM players WHERE uuid = ?").get(uuid) as PlayerInfo | undefined;
  }

  findPlayerByName(name: string): PlayerInfo | undefined {
    return this.db
      .prepare("SELECT uuid, name FROM players WHERE name = ? COLLATE NOCASE ORDER BY last_seen DESC LIMIT 1")
      .get(name) as PlayerInfo | undefined;
  }

  /** Stores a fresh link code for a player, replacing any earlier one. */
  createLinkCode(code: string, playerUuid: string, expiresAt: number): void {
    this.db.prepare("DELETE FROM link_codes WHERE player_uuid = ? OR expires_at < ?").run(playerUuid, Date.now());
    this.db.prepare("INSERT INTO link_codes (code, player_uuid, expires_at) VALUES (?, ?, ?)").run(code, playerUuid, expiresAt);
  }

  /** Deletes the code and returns its player if it existed and had not expired. */
  consumeLinkCode(code: string): string | undefined {
    const row = this.db.prepare("DELETE FROM link_codes WHERE code = ? RETURNING player_uuid, expires_at").get(code) as
      | { player_uuid: string; expires_at: number }
      | undefined;
    return row && row.expires_at > Date.now() ? row.player_uuid : undefined;
  }

  createSession(tokenHash: string, playerUuid: string, expiresAt: number): void {
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").run(Date.now());
    this.db
      .prepare("INSERT INTO web_sessions (token_hash, player_uuid, expires_at) VALUES (?, ?, ?)")
      .run(tokenHash, playerUuid, expiresAt);
  }

  findSession(tokenHash: string): string | undefined {
    const row = this.db
      .prepare("SELECT player_uuid FROM web_sessions WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, Date.now()) as { player_uuid: string } | undefined;
    return row?.player_uuid;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(tokenHash);
  }

  grant(playerUuid: string, cosmeticId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO ownership (player_uuid, cosmetic_id, granted_at) VALUES (?, ?, ?)")
      .run(playerUuid, cosmeticId, Date.now());
  }

  revoke(playerUuid: string, cosmeticId: string): void {
    this.db.prepare("DELETE FROM equipped WHERE player_uuid = ? AND cosmetic_id = ?").run(playerUuid, cosmeticId);
    this.db.prepare("DELETE FROM ownership WHERE player_uuid = ? AND cosmetic_id = ?").run(playerUuid, cosmeticId);
  }

  owns(playerUuid: string, cosmeticId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM ownership WHERE player_uuid = ? AND cosmetic_id = ?")
      .get(playerUuid, cosmeticId);
  }

  ownedCosmetics(playerUuid: string): Cosmetic[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.type, c.claimable, c.data FROM ownership o
         JOIN cosmetics c ON c.id = o.cosmetic_id
         WHERE o.player_uuid = ? ORDER BY c.id`,
      )
      .all(playerUuid);
    return (rows as unknown as CosmeticRow[]).map(toCosmetic);
  }

  equipped(playerUuid: string): Record<string, string> {
    const rows = this.db
      .prepare("SELECT slot, cosmetic_id FROM equipped WHERE player_uuid = ?")
      .all(playerUuid) as unknown as { slot: string; cosmetic_id: string }[];
    return Object.fromEntries(rows.map((r) => [r.slot, r.cosmetic_id]));
  }

  equip(playerUuid: string, slot: string, cosmeticId: string): void {
    this.db
      .prepare(
        `INSERT INTO equipped (player_uuid, slot, cosmetic_id) VALUES (?, ?, ?)
         ON CONFLICT(player_uuid, slot) DO UPDATE SET cosmetic_id = excluded.cosmetic_id`,
      )
      .run(playerUuid, slot, cosmeticId);
  }

  unequip(playerUuid: string, slot: string): void {
    this.db.prepare("DELETE FROM equipped WHERE player_uuid = ? AND slot = ?").run(playerUuid, slot);
  }
}
