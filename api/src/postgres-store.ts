import pg from "pg";
import { toCosmetic, type Cosmetic, type CosmeticRow, type ServerInfo, type Store } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cosmetics (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS server_keys (
  key_hash   TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES servers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS server_keys_server ON server_keys(server_id);
CREATE TABLE IF NOT EXISTS ownership (
  player_uuid TEXT NOT NULL,
  cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_uuid, cosmetic_id)
);
CREATE TABLE IF NOT EXISTS equipped (
  player_uuid TEXT NOT NULL,
  slot        TEXT NOT NULL,
  cosmetic_id TEXT NOT NULL REFERENCES cosmetics(id),
  PRIMARY KEY (player_uuid, slot)
);
`;

// Arbitrary constant so concurrently booting instances don't race on CREATE TABLE.
const SCHEMA_LOCK = 7_210_431;

/** Shared store for hosted deployments; any number of API instances can point at one database. */
export class PostgresStore implements Store {
  private readonly pool: pg.Pool;

  private constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async connect(connectionString: string): Promise<PostgresStore> {
    const pool = new pg.Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK]);
      await client.query(SCHEMA);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return new PostgresStore(pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listCosmetics(): Promise<Cosmetic[]> {
    const { rows } = await this.pool.query<CosmeticRow>("SELECT id, name, type, data FROM cosmetics ORDER BY id");
    return rows.map(toCosmetic);
  }

  async getCosmetic(id: string): Promise<Cosmetic | undefined> {
    const { rows } = await this.pool.query<CosmeticRow>("SELECT id, name, type, data FROM cosmetics WHERE id = $1", [id]);
    return rows[0] ? toCosmetic(rows[0]) : undefined;
  }

  async upsertCosmetic(c: Omit<Cosmetic, "slot">): Promise<Cosmetic> {
    const { rows } = await this.pool.query<CosmeticRow>(
      `INSERT INTO cosmetics (id, name, type, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, type = excluded.type, data = excluded.data
       RETURNING id, name, type, data`,
      [c.id, c.name, c.type, JSON.stringify(c.data)],
    );
    return toCosmetic(rows[0]);
  }

  async createServer(id: string, name: string, keyHash: string): Promise<void> {
    await this.tx(async (db) => {
      await db.query("INSERT INTO servers (id, name) VALUES ($1, $2)", [id, name]);
      await db.query("INSERT INTO server_keys (key_hash, server_id) VALUES ($1, $2)", [keyHash, id]);
    });
  }

  async listServers(): Promise<ServerInfo[]> {
    const { rows } = await this.pool.query<{ id: string; name: string; created_at: Date; revoked_at: Date | null }>(
      "SELECT id, name, created_at, revoked_at FROM servers ORDER BY created_at, id",
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at.toISOString(),
      revokedAt: r.revoked_at?.toISOString() ?? null,
    }));
  }

  async findServerByKeyHash(keyHash: string): Promise<{ id: string; name: string } | undefined> {
    const { rows } = await this.pool.query<{ id: string; name: string }>(
      `SELECT s.id, s.name FROM server_keys k JOIN servers s ON s.id = k.server_id
       WHERE k.key_hash = $1 AND s.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`,
      [keyHash],
    );
    return rows[0];
  }

  async rotateServerKey(id: string, newKeyHash: string, graceMs: number): Promise<boolean> {
    return this.tx(async (db) => {
      // Lock the server row so a concurrent revoke can't slip in between the check and the insert.
      const server = await db.query("SELECT 1 FROM servers WHERE id = $1 AND revoked_at IS NULL FOR UPDATE", [id]);
      if (server.rowCount === 0) return false;
      await db.query(
        `UPDATE server_keys
         SET expires_at = LEAST(COALESCE(expires_at, 'infinity'), now() + $2 * interval '1 millisecond')
         WHERE server_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
        [id, graceMs],
      );
      await db.query("INSERT INTO server_keys (key_hash, server_id) VALUES ($1, $2)", [newKeyHash, id]);
      return true;
    });
  }

  async revokeServer(id: string): Promise<boolean> {
    const res = await this.pool.query("UPDATE servers SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1", [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async grant(playerUuid: string, cosmeticId: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO ownership (player_uuid, cosmetic_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [playerUuid, cosmeticId],
    );
  }

  async owns(playerUuid: string, cosmeticId: string): Promise<boolean> {
    const res = await this.pool.query("SELECT 1 FROM ownership WHERE player_uuid = $1 AND cosmetic_id = $2", [
      playerUuid,
      cosmeticId,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async ownedCosmetics(playerUuid: string): Promise<Cosmetic[]> {
    const { rows } = await this.pool.query<CosmeticRow>(
      `SELECT c.id, c.name, c.type, c.data FROM ownership o
       JOIN cosmetics c ON c.id = o.cosmetic_id
       WHERE o.player_uuid = $1 ORDER BY c.id`,
      [playerUuid],
    );
    return rows.map(toCosmetic);
  }

  async equipped(playerUuid: string): Promise<Record<string, string>> {
    const { rows } = await this.pool.query<{ slot: string; cosmetic_id: string }>(
      "SELECT slot, cosmetic_id FROM equipped WHERE player_uuid = $1",
      [playerUuid],
    );
    return Object.fromEntries(rows.map((r) => [r.slot, r.cosmetic_id]));
  }

  async equip(playerUuid: string, slot: string, cosmeticId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO equipped (player_uuid, slot, cosmetic_id) VALUES ($1, $2, $3)
       ON CONFLICT (player_uuid, slot) DO UPDATE SET cosmetic_id = excluded.cosmetic_id`,
      [playerUuid, slot, cosmeticId],
    );
  }

  async unequip(playerUuid: string, slot: string): Promise<void> {
    await this.pool.query("DELETE FROM equipped WHERE player_uuid = $1 AND slot = $2", [playerUuid, slot]);
  }
}
