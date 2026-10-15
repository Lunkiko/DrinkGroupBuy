"use strict";

// Runs real-database smoke scripts inside a THROWAWAY PostgreSQL schema: it creates the schema, applies every
// migration to it, runs each given script with DATABASE_URL pointing at that schema, then drops the schema. The
// scripts' own fixture rows therefore never touch the tables of the database that DATABASE_URL names.
//
//   node scripts/with-temp-schema.js scripts/pickup-credential-postgres-smoke.js scripts/pickup-concurrency-postgres-smoke.js
//   npm run test:db
//
// Why this exists: the unit tests (npm test) use a fake database, so they never send this project's SQL to
// PostgreSQL. A query that PostgreSQL rejects (the 2026-10-01 "FOR UPDATE cannot be applied to the nullable side
// of an outer join" in mark-ready for pickup) therefore passes every unit test and ships. These scripts are the
// ones that catch it, and this runner makes them safe and one command to run.
//
// Refuses a database that is not on this computer: it creates and drops a schema, which must never happen on a
// shared or production database.

require("../backend/auth"); // loads backend/.env for variables that are not already set
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const { runMigrations } = require("../database/migrate");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const repoRoot = path.join(__dirname, "..");

async function main() {
  const scripts = process.argv.slice(2);
  if (scripts.length === 0) throw new Error("用法：node scripts/with-temp-schema.js <smoke 腳本> [更多腳本...]");
  if (!process.env.DATABASE_URL) throw new Error("需要設定 DATABASE_URL 才知道要連哪個資料庫。");

  const target = new URL(process.env.DATABASE_URL);
  const hostOverridden = target.searchParams.has("host") || target.searchParams.has("hostaddr");
  if (!LOCAL_HOSTS.has(target.hostname) || hostOverridden) {
    throw new Error(`拒絕執行：${target.hostname} 不是本機資料庫。這個執行器會建立並刪除 schema，只能用在本機。`);
  }

  const schema = `temp_smoke_${randomUUID().replace(/-/g, "_")}`;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let failed = 0;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const migrated = await runMigrations(client);
    console.log(`暫時 schema ${schema}：已套用 ${migrated.appliedCount} 個 migration`);

    const scriptUrl = new URL(process.env.DATABASE_URL);
    scriptUrl.searchParams.set("options", `-c search_path=${schema}`);
    for (const script of scripts) {
      const result = spawnSync(process.execPath, [script], {
        cwd: repoRoot, env: { ...process.env, DATABASE_URL: scriptUrl.toString() }, encoding: "utf8",
      });
      const ok = result.status === 0;
      console.log(`\n${ok ? "通過" : "失敗"}  ${script}`);
      if (result.stdout.trim()) console.log(result.stdout.trim());
      if (!ok && result.stderr.trim()) console.log(result.stderr.trim());
      if (!ok) failed += 1;
    }
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
  console.log(`\n${failed === 0 ? "全部通過" : `${failed} 個失敗`}（共 ${scripts.length} 個，暫時 schema 已刪除）`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`失敗：${error.message}`);
  process.exitCode = 1;
});
