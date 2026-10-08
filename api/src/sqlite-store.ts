import { DatabaseSync } from "node:sqlite";
import { groupEquipped, toCosmetic, type Cosmetic, type CosmeticRow, type PlayerInfo, type ServerInfo, type Store } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cosmetics (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  claimable  INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS server_keys (
  key_hash   TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES servers(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS server_keys_server ON server_keys(server_id);
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
CREATE TABLE IF NOT EXISTS assets (
  id         TEXT PRIMARY KEY,
  data       BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS equipped (
  player_uuid TEXT NOT NULL,
  slot        TEXT NOT NULL,
  cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id),
  PRIMARY KEY (player_uuid, slot)
);
`;

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

/** Single-file store for local development and tests. Not safe to share between API instances. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // Databases created before claimable cosmetics existed.
    const columns = this.db.prepare("PRAGMA table_info(cosmetics)").all() as unknown as { name: string }[];
    if (!columns.some((c) => c.name === "claimable")) {
      this.db.exec("ALTER TABLE cosmetics ADD COLUMN claimable INTEGER NOT NULL DEFAULT 0");
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async listCosmetics(): Promise<Cosmetic[]> {
    const rows = this.db.prepare("SELECT id, name, type, claimable, data FROM cosmetics ORDER BY id").all();
    return (rows as unknown as CosmeticRow[]).map(toCosmetic);
  }

  async getCosmetic(id: string): Promise<Cosmetic | undefined> {
    const row = this.db.prepare("SELECT id, name, type, claimable, data FROM cosmetics WHERE id = ?").get(id);
    return row ? toCosmetic(row as unknown as CosmeticRow) : undefined;
  }

  async upsertCosmetic(c: Omit<Cosmetic, "slot">): Promise<Cosmetic> {
    this.db
      .prepare(
        `INSERT INTO cosmetics (id, name, type, claimable, data, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type,
           claimable = excluded.claimable, data = excluded.data`,
      )
      .run(c.id, c.name, c.type, c.claimable ? 1 : 0, JSON.stringify(c.data), Date.now());
    return (await this.getCosmetic(c.id))!;
  }

  async createServer(id: string, name: string, keyHash: string): Promise<void> {
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO servers (id, name, created_at) VALUES (?, ?, ?)").run(id, name, now);
      this.db.prepare("INSERT INTO server_keys (key_hash, server_id, created_at) VALUES (?, ?, ?)").run(keyHash, id, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async listServers(): Promise<ServerInfo[]> {
    const rows = this.db.prepare("SELECT id, name, created_at, revoked_at FROM servers ORDER BY created_at, id").all() as unknown as {
      id: string;
      name: string;
      created_at: number;
      revoked_at: number | null;
    }[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: iso(r.created_at)!, revokedAt: iso(r.revoked_at) }));
  }

  async findServerByKeyHash(keyHash: string): Promise<{ id: string; name: string } | undefined> {
    const row = this.db
      .prepare(
        `SELECT s.id, s.name FROM server_keys k JOIN servers s ON s.id = k.server_id
         WHERE k.key_hash = ? AND s.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)`,
      )
      .get(keyHash, Date.now());
    return row ? { id: String(row.id), name: String(row.name) } : undefined;
  }

  async rotateServerKey(id: string, newKeyHash: string, graceMs: number): Promise<boolean> {
    const now = Date.now();
    const server = this.db.prepare("SELECT 1 FROM servers WHERE id = ? AND revoked_at IS NULL").get(id);
    if (!server) return false;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE server_keys SET expires_at = MIN(COALESCE(expires_at, ?1), ?1)
           WHERE server_id = ?2 AND (expires_at IS NULL OR expires_at > ?3)`,
        )
        .run(now + graceMs, id, now);
      this.db.prepare("INSERT INTO server_keys (key_hash, server_id, created_at) VALUES (?, ?, ?)").run(newKeyHash, id, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return true;
  }

  async revokeServer(id: string): Promise<boolean> {
    const res = this.db.prepare("UPDATE servers SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(Date.now(), id);
    return res.changes > 0;
  }

  async seePlayer(uuid: string, name: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO players (uuid, name, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
      )
      .run(uuid, name, Date.now());
  }

  async getPlayer(uuid: string): Promise<PlayerInfo | undefined> {
    return this.db.prepare("SELECT uuid, name FROM players WHERE uuid = ?").get(uuid) as PlayerInfo | undefined;
  }

  async findPlayerByName(name: string): Promise<PlayerInfo | undefined> {
    return this.db
      .prepare("SELECT uuid, name FROM players WHERE name = ? COLLATE NOCASE ORDER BY last_seen DESC LIMIT 1")
      .get(name) as PlayerInfo | undefined;
  }

  async createLinkCode(code: string, playerUuid: string, expiresAt: number): Promise<void> {
    this.db.prepare("DELETE FROM link_codes WHERE player_uuid = ? OR expires_at < ?").run(playerUuid, Date.now());
    this.db.prepare("INSERT INTO link_codes (code, player_uuid, expires_at) VALUES (?, ?, ?)").run(code, playerUuid, expiresAt);
  }

  async consumeLinkCode(code: string): Promise<string | undefined> {
    const row = this.db.prepare("DELETE FROM link_codes WHERE code = ? RETURNING player_uuid, expires_at").get(code) as
      | { player_uuid: string; expires_at: number }
      | undefined;
    return row && row.expires_at > Date.now() ? row.player_uuid : undefined;
  }

  async createSession(tokenHash: string, playerUuid: string, expiresAt: number): Promise<void> {
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").run(Date.now());
    this.db
      .prepare("INSERT INTO web_sessions (token_hash, player_uuid, expires_at) VALUES (?, ?, ?)")
      .run(tokenHash, playerUuid, expiresAt);
  }

  async findSession(tokenHash: string): Promise<string | undefined> {
    const row = this.db
      .prepare("SELECT player_uuid FROM web_sessions WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, Date.now()) as { player_uuid: string } | undefined;
    return row?.player_uuid;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(tokenHash);
  }

  async grant(playerUuid: string, cosmeticId: string): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO ownership (player_uuid, cosmetic_id, granted_at) VALUES (?, ?, ?)")
      .run(playerUuid, cosmeticId, Date.now());
  }

  async revoke(playerUuid: string, cosmeticId: string): Promise<void> {
    this.db.prepare("DELETE FROM equipped WHERE player_uuid = ? AND cosmetic_id = ?").run(playerUuid, cosmeticId);
    this.db.prepare("DELETE FROM ownership WHERE player_uuid = ? AND cosmetic_id = ?").run(playerUuid, cosmeticId);
  }

  async owns(playerUuid: string, cosmeticId: string): Promise<boolean> {
    return !!this.db
      .prepare("SELECT 1 FROM ownership WHERE player_uuid = ? AND cosmetic_id = ?")
      .get(playerUuid, cosmeticId);
  }

  async ownedCosmetics(playerUuid: string): Promise<Cosmetic[]> {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.type, c.claimable, c.data FROM ownership o
         JOIN cosmetics c ON c.id = o.cosmetic_id
         WHERE o.player_uuid = ? ORDER BY c.id`,
      )
      .all(playerUuid);
    return (rows as unknown as CosmeticRow[]).map(toCosmetic);
  }

  async equipped(playerUuid: string): Promise<Record<string, string>> {
    const rows = this.db
      .prepare("SELECT slot, cosmetic_id FROM equipped WHERE player_uuid = ?")
      .all(playerUuid) as unknown as { slot: string; cosmetic_id: string }[];
    return Object.fromEntries(rows.map((r) => [r.slot, r.cosmetic_id]));
  }

  async equip(playerUuid: string, slot: string, cosmeticId: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO equipped (player_uuid, slot, cosmetic_id) VALUES (?, ?, ?)
         ON CONFLICT(player_uuid, slot) DO UPDATE SET cosmetic_id = excluded.cosmetic_id`,
      )
      .run(playerUuid, slot, cosmeticId);
  }

  async unequip(playerUuid: string, slot: string): Promise<void> {
    this.db.prepare("DELETE FROM equipped WHERE player_uuid = ? AND slot = ?").run(playerUuid, slot);
  }

  async equippedMany(playerUuids: string[]): Promise<Record<string, Record<string, string>>> {
    if (playerUuids.length === 0) return {};
    const rows = this.db
      .prepare(
        `SELECT player_uuid, slot, cosmetic_id FROM equipped
         WHERE player_uuid IN (${playerUuids.map(() => "?").join(", ")})`,
      )
      .all(...playerUuids) as unknown as { player_uuid: string; slot: string; cosmetic_id: string }[];
    return groupEquipped(rows);
  }

  async putAsset(id: string, data: Buffer): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO assets (id, data, created_at) VALUES (?, ?, ?)").run(id, data, Date.now());
  }

  async getAsset(id: string): Promise<Buffer | undefined> {
    const row = this.db.prepare("SELECT data FROM assets WHERE id = ?").get(id) as { data: Uint8Array } | undefined;
    return row ? Buffer.from(row.data) : undefined;
  }
}
