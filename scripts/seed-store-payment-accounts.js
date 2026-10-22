"use strict";

// Multi-channel LINE Pay accounts (2026-10-22): gives every store its own row in
// store_payment_accounts so the architecture (store -> own LINE Pay channel) can be exercised
// end-to-end. This round only has ONE real, working set of credentials -- the existing
// LINE_PAY_CHANNEL_ID/SECRET env vars, already registered as a real LINE Pay sandbox channel --
// so only the reference store used by smoke tests and the browser demo flow (store-001) gets
// those. Every other store gets an obviously-fake placeholder; calling LINE Pay with one of those
// will fail, which is expected until that store is given a real sandbox/production account.
//
//   node scripts/seed-store-payment-accounts.js            preview only: prints what WOULD be written
//   node scripts/seed-store-payment-accounts.js --apply    write it
//
// Idempotent: upserts on (store_id, provider), so re-running this is always safe and never
// creates duplicate rows -- see storePaymentAccountRepository.js's upsertAccount.
//
// Safety: nothing is written without --apply; a non-local database also needs --allow-remote,
// same convention as scripts/seed-demo-data.js.

require("../backend/auth"); // loads backend/.env for variables that are not already set
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const {
  createStorePaymentAccountRepository,
} = require("../backend/database/repositories/storePaymentAccountRepository");
const { describeTarget } = require("./helpers/databaseTarget");

const REFERENCE_STORE_ID = "store-001";
const PLACEHOLDER_STORE_IDS = ["store-002", "store-003", "store-004", "store-005", "store-006", "store-007"];

async function main() {
  const apply = process.argv.includes("--apply");
  const allowRemote = process.argv.includes("--allow-remote");

  if (!process.env.DATABASE_URL) {
    console.log("seed-store-payment-accounts skipped: DATABASE_URL is not set.");
    return;
  }
  const target = describeTarget(process.env.DATABASE_URL);
  if (!target.isLocal && !allowRemote) {
    console.error(
      `拒絕執行：DATABASE_URL 指向 ${target.host}/${target.database}，不是本機資料庫。` +
      "確定要在這個資料庫上寫入，請加上 --allow-remote。"
    );
    process.exitCode = 1;
    return;
  }

  if (!process.env.LINE_PAY_CHANNEL_ID || !process.env.LINE_PAY_CHANNEL_SECRET) {
    console.error("LINE_PAY_CHANNEL_ID / LINE_PAY_CHANNEL_SECRET 未設定，無法給參考店家配真的帳號。");
    process.exitCode = 1;
    return;
  }

  const accounts = [
    { storeId: REFERENCE_STORE_ID, channelId: process.env.LINE_PAY_CHANNEL_ID, channelSecret: process.env.LINE_PAY_CHANNEL_SECRET, real: true },
    ...PLACEHOLDER_STORE_IDS.map((storeId) => ({
      storeId,
      channelId: `mock-channel-${storeId}`,
      channelSecret: `mock-secret-${storeId}`,
      real: false,
    })),
  ];

  console.log(`目標資料庫：${target.host}/${target.database}（${target.isLocal ? "本機" : "遠端，已用 --allow-remote 確認"}）`);
  for (const account of accounts) {
    console.log(`  ${account.storeId}: ${account.real ? "真的 LINE Pay sandbox 帳號（沿用現有環境變數）" : `假帳號 ${account.channelId}`}`);
  }

  if (!apply) {
    console.log("\n只是預覽，沒有寫入。加上 --apply 才會真的寫進資料庫。");
    return;
  }

  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  const repository = createStorePaymentAccountRepository({ database });
  try {
    for (const account of accounts) {
      await repository.upsertAccount({
        storeId: account.storeId,
        provider: "line_pay",
        channelId: account.channelId,
        channelSecret: account.channelSecret,
      });
    }
    console.log(`\n已寫入 ${accounts.length} 筆 store_payment_accounts。`);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
