import { DatabaseSync } from "node:sqlite";
import { toCosmetic, type Cosmetic, type CosmeticRow, type ServerInfo, type Store } from "./db.ts";

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
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async listCosmetics(): Promise<Cosmetic[]> {
    const rows = this.db.prepare("SELECT id, name, type, data FROM cosmetics ORDER BY id").all();
    return (rows as unknown as CosmeticRow[]).map(toCosmetic);
  }

  async getCosmetic(id: string): Promise<Cosmetic | undefined> {
    const row = this.db.prepare("SELECT id, name, type, data FROM cosmetics WHERE id = ?").get(id);
    return row ? toCosmetic(row as unknown as CosmeticRow) : undefined;
  }

  async upsertCosmetic(c: Omit<Cosmetic, "slot">): Promise<Cosmetic> {
    this.db
      .prepare(
        `INSERT INTO cosmetics (id, name, type, data, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, data = excluded.data`,
      )
      .run(c.id, c.name, c.type, JSON.stringify(c.data), Date.now());
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

  async grant(playerUuid: string, cosmeticId: string): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO ownership (player_uuid, cosmetic_id, granted_at) VALUES (?, ?, ?)")
      .run(playerUuid, cosmeticId, Date.now());
  }

  async owns(playerUuid: string, cosmeticId: string): Promise<boolean> {
    return !!this.db
      .prepare("SELECT 1 FROM ownership WHERE player_uuid = ? AND cosmetic_id = ?")
      .get(playerUuid, cosmeticId);
  }

  async ownedCosmetics(playerUuid: string): Promise<Cosmetic[]> {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.type, c.data FROM ownership o
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
}
