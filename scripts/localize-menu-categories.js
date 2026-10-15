"use strict";

// Rewrites the English category codes that the seeded stores still use (coffee, fruit, milk_tea, tea) into the Chinese
// names the other stores already use. The customer's ordering screen shows the category column as-is, so those codes
// appear to customers as English chips. Only the category text of menu_items changes: no prices, items, options or
// orders, and old (retired) items are rewritten too so a store never ends up with both spellings.
//
//   node scripts/localize-menu-categories.js                  preview only: prints what WOULD change
//   node scripts/localize-menu-categories.js --apply          write it
//
// Options:
//   --allow-remote   required when DATABASE_URL points anywhere other than this computer (for example the Azure demo database)
//
// Mapping: coffee -> 咖啡類, fruit -> 果茶類, milk_tea -> 鮮奶茶類, tea -> 茶類 (the wording stores 002 and 007 already use).
//
// Safety: nothing is written without --apply; a non-local database also needs --allow-remote; the whole change is one
// transaction; running it again changes nothing. Take a backup before using --apply on a database that matters
// (for the Azure demo database: pg_dump, or the Azure portal's backup).

require("../backend/auth"); // loads backend/.env for variables that are not already set
const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("../backend/database");

const { describeTarget } = require("./helpers/databaseTarget");
const CATEGORY_MAP = [
  ["coffee", "咖啡類"],
  ["fruit", "果茶類"],
  ["milk_tea", "鮮奶茶類"],
  ["tea", "茶類"],
];

async function countByStoreAndCategory(database) {
  const result = await database.query(`
    SELECT store_id, category, COUNT(*)::integer AS n
    FROM menu_items WHERE category = ANY($1::text[])
    GROUP BY store_id, category ORDER BY store_id, category
  `, [CATEGORY_MAP.map(([from]) => from)]);
  return result.rows;
}

async function main() {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((flag) => !["--apply", "--allow-remote", "--help", "-h"].includes(flag));
  if (unknown.length > 0) throw new Error(`不認得的參數：${unknown.join("、")}（用 --help 看說明）`);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(require("node:fs").readFileSync(__filename, "utf8").split("\n").slice(2, 20).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  const apply = argv.includes("--apply");
  if (!process.env.DATABASE_URL) throw new Error("需要設定 DATABASE_URL 才知道要連哪個資料庫。");
  const target = describeTarget(process.env.DATABASE_URL);
  console.log(`目標資料庫：${target.host} / ${target.database}（${target.isLocal ? "本機" : "遠端"}）`);
  if (!target.isLocal && !argv.includes("--allow-remote")) {
    throw new Error("目標不是本機資料庫。若確定要寫入遠端（例如 Azure 展示環境），請加上 --allow-remote。");
  }

  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  try {
    const rows = await countByStoreAndCategory(database);
    if (rows.length === 0) return console.log("沒有英文分類代碼，不需要修改。");
    const toChinese = new Map(CATEGORY_MAP);
    console.log("\n將要修改（含已下架的舊品項）：");
    for (const row of rows) console.log(`  ${row.store_id}  ${row.category} → ${toChinese.get(row.category)}：${row.n} 筆`);
    const total = rows.reduce((sum, row) => sum + row.n, 0);
    if (!apply) return console.log(`\n共 ${total} 筆。這是預覽，沒有寫入任何東西。確定要寫入請加上 --apply（寫入前請先備份）。`);

    const now = new Date().toISOString();
    await database.transaction(async (transaction) => {
      for (const [from, to] of CATEGORY_MAP) {
        await transaction.query("UPDATE menu_items SET category = $2, updated_at = $3 WHERE category = $1", [from, to, now]);
      }
      await transaction.query(`
        INSERT INTO audit_logs (id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at)
        VALUES ($1, NULL, 'admin_localize_menu_categories', 'menu_items', 'category-localization', $2::jsonb, $3)
      `, [`audit-log-${randomUUID()}`, JSON.stringify({ map: Object.fromEntries(CATEGORY_MAP), updatedCount: total }), now]);
    });
    const left = await countByStoreAndCategory(database);
    if (left.length > 0) throw new Error(`修改後仍有英文分類代碼：${JSON.stringify(left)}`);
    console.log(`\n已修改 ${total} 筆，英文分類代碼殘留 0 筆。`);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(`失敗：${error.message}`);
  process.exitCode = 1;
});
