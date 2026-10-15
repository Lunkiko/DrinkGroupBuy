"use strict";

// Fills a PostgreSQL database with DEMO history (fake customers, finished group buys spread over the
// past weeks, orders, mock payments, settlements, pickups) so the statistics pages and each
// customer's "money saved" card have something to show. See scripts/helpers/demoDataBuilder.js.
//
//   node scripts/seed-demo-data.js                     preview only: prints what WOULD be written
//   node scripts/seed-demo-data.js --apply             write it
//   node scripts/seed-demo-data.js --cleanup --apply   remove everything this script ever wrote
//
// Options:
//   --focus-email <email>   give this real (already registered) customer many orders; repeatable
//   --focus-user-id <id>    same, by user id; repeatable
//   --activities <n>  (30)  --customers <n> (24)  --days <n> (60)  --seed <n> (20260925)
//   --allow-remote          required when DATABASE_URL points anywhere other than this computer
//
// Safety: nothing is written without --apply; a non-local database also needs --allow-remote; all
// rows use ids starting with "demo-seed-" and the mock payment provider; the whole write is one
// transaction, so a failure leaves the database untouched.

require("../backend/auth"); // loads backend/.env for variables that are not already set
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const {
  createCustomerSavingsRepository,
} = require("../backend/database/repositories/customerSavingsRepository");
const { DEMO_PREFIX, buildDemoData } = require("./helpers/demoDataBuilder");

const { describeTarget } = require("./helpers/databaseTarget");
const REQUIRED_MIGRATION_COLUMN = { table: "promotion_tiers", column: "discount_percent" };
const IDENTIFIER = /^[a-z_]+$/;

// Insert order respects foreign keys; cleanup walks the same list backwards.
const TABLES = [
  { key: "users", table: "users", idColumn: "id" },
  { key: "userRoles", table: "user_roles", idColumn: "user_id" },
  { key: "privateProfiles", table: "user_private_profiles", idColumn: "user_id" },
  { key: "publicProfiles", table: "user_public_profiles", idColumn: "user_id" },
  { key: "activities", table: "group_buy_activities", idColumn: "id" },
  { key: "tiers", table: "promotion_tiers", idColumn: "activity_id" },
  { key: "orders", table: "orders", idColumn: "id" },
  { key: "orderItems", table: "order_items", idColumn: "order_id" },
  { key: "consents", table: "order_rule_consents", idColumn: "order_id" },
  { key: "authorizations", table: "payment_authorizations", idColumn: "order_id" },
  { key: "captures", table: "payment_captures", idColumn: "order_id" },
  { key: "refunds", table: "payment_refunds", idColumn: "order_id" },
  { key: "credentials", table: "pickup_credentials", idColumn: "order_id" },
  { key: "settlements", table: "activity_settlements", idColumn: "activity_id" },
];

function parseArguments(argv) {
  const options = {
    apply: false, cleanup: false, allowRemote: false, help: false,
    seed: 20260925, activities: 30, customers: 24, days: 60,
    focusEmails: [], focusUserIds: [],
  };
  const numeric = { "--seed": "seed", "--activities": "activities", "--customers": "customers", "--days": "days" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") options.apply = true;
    else if (flag === "--cleanup") options.cleanup = true;
    else if (flag === "--allow-remote") options.allowRemote = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--focus-email" || flag === "--focus-user-id" || numeric[flag]) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} 需要一個值`);
      index += 1;
      if (flag === "--focus-email") options.focusEmails.push(value);
      else if (flag === "--focus-user-id") options.focusUserIds.push(value);
      else {
        const number = Number(value);
        if (!Number.isInteger(number)) throw new Error(`${flag} 必須是整數，收到 "${value}"`);
        options[numeric[flag]] = number;
      }
    } else {
      throw new Error(`不認得的參數：${flag}（用 --help 看說明）`);
    }
  }
  return options;
}

async function ensureSchemaReady(database) {
  const result = await database.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
    [REQUIRED_MIGRATION_COLUMN.table, REQUIRED_MIGRATION_COLUMN.column],
  );
  if (result.rows.length === 0) {
    throw new Error(
      "這個資料庫還沒套用 migration 008（百分比折扣），欄位 promotion_tiers.discount_percent 不存在。"
      + "請先照 docs/azure-classroom-deployment.md 套用 migration，再執行本腳本。",
    );
  }
}

async function resolveFocusUsers(database, options) {
  const found = new Map();
  const lookup = async (column, value) => {
    const result = await database.query(`
      SELECT user_account.id, user_account.email
      FROM users user_account
      JOIN user_roles user_role ON user_role.user_id = user_account.id
      WHERE ${column === "email" ? "lower(user_account.email) = lower($1)" : "user_account.id = $1"}
        AND user_account.status = 'active'
        AND user_role.role = 'customer' AND user_role.status = 'active'
    `, [value]);
    if (result.rows.length === 0) {
      throw new Error(
        `找不到啟用中的顧客帳號：${value}。真實帳號要先用 Google 登入 App 一次（會自動建立顧客帳號），再執行本腳本。`,
      );
    }
    found.set(result.rows[0].id, result.rows[0].email || result.rows[0].id);
  };
  for (const email of options.focusEmails) await lookup("email", email);
  for (const userId of options.focusUserIds) await lookup("id", userId);

  // The built-in test customers (顧客 A-D, seeded by migration 002 into every migrated database,
  // Azure included) always take part too, so their personal pages are populated as well.
  const devCustomers = await database.query(`
    SELECT user_account.id FROM users user_account
    JOIN user_roles user_role ON user_role.user_id = user_account.id
    WHERE user_account.id LIKE 'user-customer-%' AND user_account.status = 'active'
      AND user_role.role = 'customer' AND user_role.status = 'active'
    ORDER BY user_account.id
  `);
  for (const row of devCustomers.rows) if (!found.has(row.id)) found.set(row.id, row.id);
  return found;
}

async function countDemoRows(database) {
  const counts = {};
  for (const { key, table, idColumn } of TABLES) {
    const result = await database.query(
      `SELECT COUNT(*)::integer AS n FROM ${table} WHERE ${idColumn} LIKE $1`, [`${DEMO_PREFIX}%`],
    );
    counts[key] = result.rows[0].n;
  }
  return counts;
}

async function insertRows(transaction, table, rows) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  if (!IDENTIFIER.test(table) || !columns.every((column) => IDENTIFIER.test(column))) {
    throw new Error(`Unsafe identifier in ${table}`);
  }
  const rowsPerStatement = Math.max(1, Math.floor(30000 / columns.length));
  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const chunk = rows.slice(offset, offset + rowsPerStatement);
    const parameters = [];
    const tuples = chunk.map((row) => {
      if (Object.keys(row).length !== columns.length) throw new Error(`Inconsistent row shape for ${table}`);
      const placeholders = columns.map((column) => {
        parameters.push(row[column]);
        return `$${parameters.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await transaction.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`, parameters);
  }
}

async function runCleanup(database, options) {
  const counts = await countDemoRows(database);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  console.log(`目前資料庫裡的示範資料：${JSON.stringify(counts)}`);
  if (total === 0) return console.log("沒有示範資料，不需要清除。");
  if (!options.apply) return console.log("這是預覽，沒有刪除任何東西。確定要刪除請加上 --apply。");
  await database.transaction(async (transaction) => {
    for (const { table, idColumn } of [...TABLES].reverse()) {
      await transaction.query(`DELETE FROM ${table} WHERE ${idColumn} LIKE $1`, [`${DEMO_PREFIX}%`]);
    }
  });
  const after = await countDemoRows(database);
  const remaining = Object.values(after).reduce((sum, value) => sum + value, 0);
  if (remaining !== 0) throw new Error(`清除後仍有殘留：${JSON.stringify(after)}`);
  console.log(`已清除 ${total} 列示範資料，殘留 0 列。`);
}

async function runSeed(database, options) {
  const existing = await countDemoRows(database);
  if (Object.values(existing).some((value) => value > 0)) {
    throw new Error(
      `資料庫裡已經有示範資料（${JSON.stringify(existing)}）。要重新產生，請先執行：--cleanup --apply`,
    );
  }
  const stores = (await database.query(
    "SELECT id, name FROM stores WHERE business_status = 'open' ORDER BY id",
  )).rows;
  const menuItems = stores.length === 0 ? [] : (await database.query(`
    SELECT id, store_id, name, base_price FROM menu_items
    WHERE is_available = true AND store_id = ANY($1::text[]) ORDER BY id
  `, [stores.map((store) => store.id)])).rows;
  const focus = await resolveFocusUsers(database, options);
  if (focus.size === 0) {
    console.log("提醒：沒有指定 --focus-email / --focus-user-id，任何真實帳號的個人中心都不會有省錢數字。");
  } else {
    console.log(`重點顧客（會參加大部分團購）：${[...focus.values()].join("、")}`);
  }

  const data = buildDemoData({
    seed: options.seed, activityCount: options.activities, customerCount: options.customers,
    dayRange: options.days, stores, menuItems, focusUserIds: [...focus.keys()],
  });
  console.log("將要產生：");
  console.log(JSON.stringify(data.summary, null, 2));
  if (!options.apply) return console.log("\n這是預覽，沒有寫入任何東西。確定要寫入請加上 --apply。");

  await database.transaction(async (transaction) => {
    for (const { key, table } of TABLES) await insertRows(transaction, table, data[key]);
  });
  const written = await countDemoRows(database);
  console.log(`\n已寫入。資料庫裡的示範資料：${JSON.stringify(written)}`);

  const savings = createCustomerSavingsRepository({ database });
  for (const [userId, label] of focus) {
    const summary = await savings.getSavingsSummary(userId);
    console.log(`${label} 的個人中心會顯示：累計省下 $${summary.totalSavedAmount}，`
      + `${summary.savedOrderCount} 筆訂單、${summary.savedCupCount} 杯`);
  }
  console.log("\n要移除這些示範資料：node scripts/seed-demo-data.js --cleanup --apply");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(require("node:fs").readFileSync(__filename, "utf8").split("\n").slice(2, 20)
      .map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error("需要設定 DATABASE_URL 才知道要連哪個資料庫。");
  const target = describeTarget(process.env.DATABASE_URL);
  console.log(`目標資料庫：${target.host} / ${target.database}（${target.isLocal ? "本機" : "遠端"}）`);
  if (!target.isLocal && !options.allowRemote) {
    throw new Error("目標不是本機資料庫。若確定要寫入遠端（例如 Azure 展示環境），請加上 --allow-remote。");
  }

  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  try {
    await ensureSchemaReady(database);
    if (options.cleanup) await runCleanup(database, options);
    else await runSeed(database, options);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(`失敗：${error.message}`);
  process.exitCode = 1;
});
