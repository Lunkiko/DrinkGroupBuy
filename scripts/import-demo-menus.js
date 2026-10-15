"use strict";

// Replaces the menu of the seeded demo stores with the full menus in database/demo-menu/menus.json (exported
// from the Azure demo backend, categories already in Chinese). The seeded stores only have one or two drinks each,
// which is too thin for a demo. Same effect as pasting each store's CSV into /admin/stores/<id>/import-menu, but in
// one command: the old items are RETIRED (is_available = false), never deleted, so historical orders keep a valid
// reference. It calls the same repository the admin import page uses.
//
//   node scripts/import-demo-menus.js                    preview only: prints what WOULD change
//   node scripts/import-demo-menus.js --apply            write it
//
// Options:
//   --stores store-001,store-003   only these stores (default: every store in the file)
//   --file <path>                  another menus file (default: database/demo-menu/menus.json)
//   --allow-remote                 required when DATABASE_URL points anywhere other than this computer
//
// Safety: nothing is written without --apply; a non-local database also needs --allow-remote; a store with a group
// buy in progress (draft, recruiting, confirmed, ordering, ready_for_pickup) is skipped; a store whose menu already
// equals the file is skipped, so running it twice changes nothing; every store is its own transaction. Take a backup
// first (scripts\backup-vm-database.ps1 on the VM).
//
// Run this BEFORE scripts/seed-demo-data.js: the demo orders are built from the menu items that exist at that moment.

const fs = require("node:fs");
const path = require("node:path");
require("../backend/auth"); // loads backend/.env for variables that are not already set
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const { createMerchantMenuImportRepository } = require("../backend/database/repositories/merchantMenuImportRepository");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const BUSY_ACTIVITY_STATUSES = ["draft", "recruiting", "confirmed", "ordering", "ready_for_pickup"];
const OPTION_TYPES = new Set(["sweetness", "ice", "size", "topping"]);
const DEFAULT_FILE = path.join(__dirname, "..", "database", "demo-menu", "menus.json");

function parseArguments(argv) {
  const options = { apply: false, allowRemote: false, help: false, stores: null, file: DEFAULT_FILE };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") options.apply = true;
    else if (flag === "--allow-remote") options.allowRemote = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--stores" || flag === "--file") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} 需要一個值`);
      index += 1;
      if (flag === "--stores") options.stores = value.split(",").map((text) => text.trim()).filter(Boolean);
      else options.file = path.resolve(value);
    } else {
      throw new Error(`不認得的參數：${flag}（用 --help 看說明）`);
    }
  }
  return options;
}

function describeTarget(databaseUrl) {
  const url = new URL(databaseUrl);
  // pg lets a ?host= / ?hostaddr= query parameter override the host in the URL, so a URL that says
  // "localhost" could still connect somewhere else; treat any such override as remote.
  const hostOverridden = url.searchParams.has("host") || url.searchParams.has("hostaddr");
  return {
    host: hostOverridden ? `${url.hostname}（連線參數改指定了其他主機）` : url.hostname,
    database: url.pathname.replace(/^\//, ""),
    isLocal: LOCAL_HOSTS.has(url.hostname) && !hostOverridden,
  };
}

// Same rules the admin import page enforces on a pasted menu (validateMenuItemInput in backend/server.js),
// checked here BEFORE any write so a bad file fails as a whole instead of half-way through.
function validateMenusFile(data) {
  const problems = [];
  if (!data || typeof data.stores !== "object" || data.stores === null) return ["檔案裡沒有 stores 物件"];
  for (const [storeId, store] of Object.entries(data.stores)) {
    if (!Array.isArray(store.items) || store.items.length === 0) { problems.push(`${storeId}：沒有任何品項`); continue; }
    const names = new Set();
    for (const item of store.items) {
      const where = `${storeId}「${item.name}」`;
      if (!String(item.name || "").trim()) { problems.push(`${storeId}：有品項沒有名稱`); continue; }
      if (names.has(item.name)) problems.push(`${where}：品名重複`);
      names.add(item.name);
      if (!String(item.category || "").trim()) problems.push(`${where}：分類空白`);
      if (!Number.isInteger(item.basePrice) || item.basePrice < 0) problems.push(`${where}：價格必須是不小於 0 的整數`);
      if (typeof item.isAvailable !== "boolean") problems.push(`${where}：isAvailable 必須是布林值`);
      const seenTypes = new Set();
      for (const group of item.customizationGroups || []) {
        if (!OPTION_TYPES.has(group.optionType)) problems.push(`${where}：選項類型 ${group.optionType} 不合法`);
        if (seenTypes.has(group.optionType)) problems.push(`${where}：選項類型 ${group.optionType} 重複`);
        seenTypes.add(group.optionType);
        const labels = new Set();
        for (const option of group.options || []) {
          if (!String(option.label || "").trim()) problems.push(`${where}：${group.optionType} 有選項沒有名稱`);
          if (labels.has(option.label)) problems.push(`${where}：${group.optionType} 的「${option.label}」重複`);
          labels.add(option.label);
          if (!Number.isInteger(option.priceDelta) || option.priceDelta < 0) problems.push(`${where}：${group.optionType}「${option.label}」加價必須是不小於 0 的整數`);
        }
        const availableCount = (group.options || []).filter((option) => option.isAvailable !== false).length;
        const { minSelections, maxSelections } = group;
        if (!Number.isInteger(minSelections) || minSelections < 0 || !Number.isInteger(maxSelections) || maxSelections < minSelections || maxSelections > availableCount) {
          problems.push(`${where}：${group.optionType} 的可選數量（${minSelections}～${maxSelections}）不合理（可選項目 ${availableCount} 個）`);
        }
      }
    }
  }
  return problems;
}

function fingerprint(items) {
  return JSON.stringify(
    items.map((item) => [item.name, item.category, Number(item.basePrice), item.description || null]).sort((a, b) => a[0].localeCompare(b[0])),
  );
}

async function planStore(database, storeId, store) {
  const storeRow = (await database.query("SELECT id, name FROM stores WHERE id = $1", [storeId])).rows[0];
  if (!storeRow) return { storeId, action: "skip", reason: "資料庫裡沒有這間店" };
  const current = (await database.query(
    "SELECT name, category, base_price, description FROM menu_items WHERE store_id = $1 AND is_available = true", [storeId],
  )).rows;
  const busy = (await database.query(
    "SELECT COUNT(*)::integer AS n FROM group_buy_activities WHERE store_id = $1 AND status = ANY($2::text[])",
    [storeId, BUSY_ACTIVITY_STATUSES],
  )).rows[0].n;
  const base = { storeId, name: storeRow.name, currentCount: current.length, newCount: store.items.length };
  if (busy > 0) return { ...base, action: "skip", reason: `有 ${busy} 場進行中的團購，不動這間店的菜單` };
  const currentPrint = fingerprint(current.map((row) => ({ name: row.name, category: row.category, basePrice: row.base_price, description: row.description })));
  if (currentPrint === fingerprint(store.items)) return { ...base, action: "skip", reason: "菜單已經跟檔案一樣" };
  return { ...base, action: "import" };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 26).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error("需要設定 DATABASE_URL 才知道要連哪個資料庫。");
  const target = describeTarget(process.env.DATABASE_URL);
  console.log(`目標資料庫：${target.host} / ${target.database}（${target.isLocal ? "本機" : "遠端"}）`);
  if (!target.isLocal && !options.allowRemote) {
    throw new Error("目標不是本機資料庫。若確定要寫入遠端，請加上 --allow-remote。");
  }

  const data = JSON.parse(fs.readFileSync(options.file, "utf8"));
  const problems = validateMenusFile(data);
  if (problems.length > 0) throw new Error(`菜單檔案有問題，沒有動資料庫：\n  - ${problems.join("\n  - ")}`);
  const storeIds = options.stores || Object.keys(data.stores);
  const unknown = storeIds.filter((storeId) => !data.stores[storeId]);
  if (unknown.length > 0) throw new Error(`檔案裡沒有這些店家：${unknown.join("、")}`);

  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  try {
    const plans = [];
    for (const storeId of storeIds) plans.push(await planStore(database, storeId, data.stores[storeId]));

    console.log("\n計畫：");
    for (const plan of plans) {
      const label = `${plan.storeId} ${plan.name || ""}`.trim();
      if (plan.action === "import") console.log(`  匯入  ${label}：目前上架 ${plan.currentCount} 項 → 換成 ${plan.newCount} 項（舊品項下架，不刪除）`);
      else console.log(`  略過  ${label}：${plan.reason}`);
    }
    const toImport = plans.filter((plan) => plan.action === "import");
    if (toImport.length === 0) return console.log("\n沒有需要匯入的店家。");
    if (!options.apply) return console.log("\n這是預覽，沒有寫入任何東西。確定要寫入請加上 --apply（寫入前請先備份）。");

    const repository = createMerchantMenuImportRepository({ database });
    console.log("");
    for (const plan of toImport) {
      const result = await repository.importMenuItems({
        storeId: plan.storeId, actorUserId: null, items: data.stores[plan.storeId].items, now: new Date().toISOString(),
      });
      if (result.error) throw new Error(`${plan.storeId} 匯入失敗：${result.error}`);
      const after = (await database.query(
        "SELECT COUNT(*)::integer AS n FROM menu_items WHERE store_id = $1 AND is_available = true", [plan.storeId],
      )).rows[0].n;
      if (after !== plan.newCount) throw new Error(`${plan.storeId} 匯入後上架品項是 ${after} 項，預期 ${plan.newCount} 項`);
      console.log(`  已匯入 ${plan.storeId}：新增 ${result.menuItemIds.length} 項、下架舊的 ${result.retiredCount} 項，現在上架 ${after} 項`);
    }
    console.log("\n完成。接著可以執行 scripts/seed-demo-data.js（展示用歷史訂單會用這些新菜單）。");
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(`失敗：${error.message}`);
  process.exitCode = 1;
});
