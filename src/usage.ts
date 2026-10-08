import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

export interface UsageRecord {
  timestamp?: string;
  requestId: string;
  alias: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  success: boolean;
}

export interface UsageTotals {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface UsageReport extends UsageTotals {
  byModel: Array<{ model: string; provider: string; requests: number; inputTokens: number; outputTokens: number; estimatedCost: number }>;
  byProvider: Array<{ provider: string; requests: number; inputTokens: number; outputTokens: number; estimatedCost: number }>;
  daily: Array<{ date: string; requests: number; estimatedCost: number }>;
  recent: UsageRecord[];
}

const emptyTotals = (): UsageTotals => ({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 });

function periodStart(period: string | undefined, now = new Date()): string | undefined {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "day") return start.toISOString();
  if (period === "week") {
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    return start.toISOString();
  }
  if (period === "month") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  return undefined;
}

export function usageDatabasePath(configPath: string): string {
  return process.env.AI_GATEWAY_DB ?? join(dirname(configPath), "usage.sqlite3");
}

export class UsageStore {
  private constructor(readonly path: string, private readonly db: Database.Database) {}

  static async open(path: string): Promise<UsageStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_records'").get();
    const createUsageTable = () => db.exec(`CREATE TABLE usage_records (
        record_id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        alias TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
        estimated_cost REAL NOT NULL CHECK(estimated_cost >= 0),
        success INTEGER NOT NULL CHECK(success IN (0, 1))
      )`);
    if (!table) {
      createUsageTable();
    } else {
      const columns = db.pragma("table_info(usage_records)") as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "record_id")) {
        const migrate = db.transaction(() => {
          db.exec("DROP INDEX IF EXISTS usage_records_timestamp_idx; DROP INDEX IF EXISTS usage_records_model_idx; ALTER TABLE usage_records RENAME TO usage_records_v1;");
          createUsageTable();
          db.exec(`INSERT INTO usage_records (request_id, timestamp, alias, model, provider, input_tokens, output_tokens, estimated_cost, success)
            SELECT request_id, timestamp, alias, model, provider, input_tokens, output_tokens, estimated_cost, success FROM usage_records_v1;
            DROP TABLE usage_records_v1;`);
        });
        migrate();
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS usage_records_timestamp_idx ON usage_records(timestamp);
      CREATE INDEX IF NOT EXISTS usage_records_model_idx ON usage_records(model, timestamp);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'));
    `);
    try { await chmod(path, 0o600); } catch { /* On platforms that do not support chmod, rely on the data directory permissions. */ }
    return new UsageStore(path, db);
  }

  record(record: UsageRecord): void {
    const insert = this.db.prepare(`
      INSERT INTO usage_records
      (request_id, timestamp, alias, model, provider, input_tokens, output_tokens, estimated_cost, success)
      VALUES (@requestId, @timestamp, @alias, @model, @provider, @inputTokens, @outputTokens, @estimatedCost, @success)
    `);
    insert.run({
      ...record,
      timestamp: record.timestamp ?? new Date().toISOString(),
      success: record.success ? 1 : 0
    });
  }

  totals(period?: string): UsageTotals {
    const since = periodStart(period);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS requests,
        COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(estimated_cost), 0) AS estimatedCost
      FROM usage_records ${since ? "WHERE timestamp >= ?" : ""}
    `).get(...(since ? [since] : [])) as UsageTotals | undefined;
    return row ?? emptyTotals();
  }

  spendSince(since: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(estimated_cost), 0) AS cost FROM usage_records WHERE success = 1 AND timestamp >= ?")
      .get(since) as { cost: number };
    return row.cost;
  }

  report(period?: string): UsageReport {
    const since = periodStart(period);
    const where = since ? "WHERE timestamp >= ?" : "";
    const params = since ? [since] : [];
    const totals = this.totals(period);
    const byModel = this.db.prepare(`
      SELECT model, provider, COUNT(*) AS requests, SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens, SUM(estimated_cost) AS estimatedCost
      FROM usage_records ${where} GROUP BY model, provider ORDER BY estimatedCost DESC
    `).all(...params) as UsageReport["byModel"];
    const byProvider = this.db.prepare(`
      SELECT provider, COUNT(*) AS requests, SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens, SUM(estimated_cost) AS estimatedCost
      FROM usage_records ${where} GROUP BY provider ORDER BY estimatedCost DESC
    `).all(...params) as UsageReport["byProvider"];
    const daily = this.db.prepare(`
      SELECT substr(timestamp, 1, 10) AS date, COUNT(*) AS requests, SUM(estimated_cost) AS estimatedCost
      FROM usage_records ${where} GROUP BY substr(timestamp, 1, 10) ORDER BY date DESC LIMIT 30
    `).all(...params) as UsageReport["daily"];
    const recent = this.db.prepare(`
      SELECT timestamp, request_id AS requestId, alias, model, provider, input_tokens AS inputTokens,
        output_tokens AS outputTokens, estimated_cost AS estimatedCost, success
      FROM usage_records ${where} ORDER BY timestamp DESC LIMIT 100
    `).all(...params) as Array<Omit<UsageRecord, "success"> & { success: number }>;
    return { ...totals, byModel, byProvider, daily, recent: recent.map((row) => ({ ...row, success: row.success === 1 })) };
  }

  close(): void { this.db.close(); }
}

export function budgetWindowStart(window: "day" | "month", now = new Date()): string {
  if (window === "day") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
