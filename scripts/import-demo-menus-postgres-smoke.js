"use strict";

// Real-database proof for scripts/import-demo-menus.js, run by npm run test:db inside a throwaway schema:
//   - preview writes nothing; apply writes; a rerun is a no-op
//   - an item marked isAvailable false is stored but not live, and the post-import count check accepts that
//   - a change that touches only an option (a topping price) is noticed and re-imported, not skipped as "same"
//   - a store with a group buy in progress is left alone
// It retires the seeded menus of two stores, so it refuses to run anywhere except the schema that
// scripts/with-temp-schema.js creates.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRuntimeDatabaseAdapter } = require("../backend/database");

const repoRoot = path.join(__dirname, "..");

function option(label, priceDelta) {
  return { label, priceDelta, isAvailable: true };
}

function menuFile(toppingPrice) {
  const groups = [
    { optionType: "sweetness", minSelections: 1, maxSelections: 1, options: [option("正常糖", 0), option("半糖", 0)] },
    { optionType: "topping", minSelections: 0, maxSelections: 2, options: [option("珍珠", toppingPrice), option("椰果", 10)] },
  ];
  return {
    stores: {
      "store-001": {
        name: "store one",
        items: [
          { name: "測試奶茶", category: "奶茶類", basePrice: 60, description: "有加料", isAvailable: true, customizationGroups: groups },
          { name: "測試綠茶", category: "茶類", basePrice: 40, description: null, isAvailable: true, customizationGroups: [] },
          // stored, but not live: the post-import count check must not count it
          { name: "停售冬瓜茶", category: "茶類", basePrice: 35, description: null, isAvailable: false, customizationGroups: [] },
        ],
      },
      "store-002": {
        name: "store two",
        items: [{ name: "測試鮮奶", category: "鮮奶茶類", basePrice: 70, description: null, isAvailable: true, customizationGroups: [] }],
      },
    },
  };
}

function runImport(file, args = []) {
  const result = spawnSync(process.execPath, ["scripts/import-demo-menus.js", "--file", file, ...args], {
    cwd: repoRoot, env: process.env, encoding: "utf8", timeout: 120_000,
  });
  return { code: result.status, out: `${result.stdout || ""}${result.stderr || ""}` };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("PostgreSQL import-demo-menus smoke skipped: DATABASE_URL is not set.");
    return;
  }
  const searchPath = new URL(process.env.DATABASE_URL).searchParams.get("options") || "";
  if (!searchPath.startsWith("-c search_path=temp_smoke_")) {
    throw new Error("這支測試會下架兩間店的菜單，只能透過 npm run test:db 在暫時 schema 裡執行。");
  }

  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-menus-smoke-"));
  const file = path.join(workDir, "menus.json");
  const writeMenu = (toppingPrice) => fs.writeFileSync(file, JSON.stringify(menuFile(toppingPrice)));
  const live = async (storeId) => Number((await database.query(
    "SELECT COUNT(*)::integer AS n FROM menu_items WHERE store_id = $1 AND is_available = true", [storeId])).rows[0].n);
  const total = async (storeId) => Number((await database.query(
    "SELECT COUNT(*)::integer AS n FROM menu_items WHERE store_id = $1", [storeId])).rows[0].n);
  const toppingPrice = async () => Number((await database.query(`
    SELECT co.price_delta FROM customization_options co JOIN menu_items mi ON mi.id = co.menu_item_id
    WHERE mi.store_id = 'store-001' AND mi.is_available = true AND mi.name = '測試奶茶' AND co.label = '珍珠'`)).rows[0].price_delta);

  try {
    writeMenu(10);
    const seededTotal = await total("store-001");

    // 1. preview
    let run = runImport(file);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /這是預覽/);
    assert.equal(await total("store-001"), seededTotal, "preview must not write");

    // 2. apply: the unavailable item is stored but not live, and the run must not trip over that
    run = runImport(file, ["--apply"]);
    assert.equal(run.code, 0, run.out);
    assert.equal(await live("store-001"), 2, "two live items; the unavailable one is not counted");
    assert.equal(await total("store-001"), seededTotal + 3, "all three file items stored, old ones retired not deleted");
    assert.equal(await live("store-002"), 1);
    assert.equal(await toppingPrice(), 10);

    // 3. rerun: identical file, nothing to do (the unavailable item must not make it look different)
    run = runImport(file, ["--apply"]);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /沒有需要匯入的店家/);
    assert.equal(await total("store-001"), seededTotal + 3, "rerun must not add rows");

    // 4. only a topping price changes: must be noticed and applied
    writeMenu(25);
    run = runImport(file);
    assert.match(run.out, /匯入 {2}store-001/, "an option-only change must be planned for import");
    run = runImport(file, ["--apply"]);
    assert.equal(run.code, 0, run.out);
    assert.equal(await toppingPrice(), 25, "the new topping price is live");
    run = runImport(file, ["--apply"]);
    assert.match(run.out, /沒有需要匯入的店家/, "and the next run is a no-op again");

    // 5. a store with a group buy in progress is skipped
    const merchant = (await database.query("SELECT user_id FROM merchant_users WHERE store_id = 'store-002' AND status = 'active' LIMIT 1")).rows[0];
    const now = Date.now();
    await database.query(`
      INSERT INTO group_buy_activities (id, store_id, created_by_user_id, title, status, start_at, deadline_at, pickup_start_at, pickup_end_at, maximum_cups, withdrawal_lock_minutes, created_at, updated_at)
      VALUES ('activity-busy-smoke', 'store-002', $1, 'busy', 'recruiting', $2, $3, $4, $5, 2, 30, $2, $2)
    `, [merchant.user_id, new Date(now - 3_600_000).toISOString(), new Date(now + 3_600_000).toISOString(),
      new Date(now + 7_200_000).toISOString(), new Date(now + 10_800_000).toISOString()]);
    const file2 = path.join(workDir, "menus-changed.json");
    const changed = menuFile(25);
    changed.stores["store-002"].items[0].basePrice = 99;
    fs.writeFileSync(file2, JSON.stringify(changed));
    run = runImport(file2, ["--apply"]);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /略過 {2}store-002.*進行中的團購/);
    assert.equal(Number((await database.query("SELECT base_price FROM menu_items WHERE store_id = 'store-002' AND is_available = true LIMIT 1")).rows[0].base_price), 70, "the busy store keeps its menu");

    console.log("PostgreSQL import-demo-menus proof passed: preview, apply, rerun, unavailable item, option-only change, busy store.");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
