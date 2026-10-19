# DrinkGroupBuy Backend

這份 README 是給開發者看的，用來說明目前本機後端、開發資料庫與測試登入資料。

## 啟動方式

在專案根目錄執行：

```powershell
npm run db:init
npm run db:seed
npm run backend:start
```

後端預設位址：

```text
http://localhost:3000
```

健康檢查：

```powershell
Invoke-RestMethod http://localhost:3000/health
```

## 目前 API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/firebase-session` | Firebase ID token login and backend role resolution |
| `GET` | `/api/auth/dev-users` | 本機 dev-only 身份清單，需 `AUTH_DEV_MODE=true`；在 Azure App Service 或 `ADMIN_WEB_LOOPBACK_ONLY=true` 的主機上不論設定為何一律關閉（`devAuthMode.js`） |
| `POST` | `/api/auth/dev-session` | 本機 dev-only 模擬登入，需 `AUTH_DEV_MODE=true`；關閉條件同上 |
| `GET` | `/health` | 後端健康檢查 |
| `GET` | `/api/group-buy-activities` | 讀取團購活動 |
| `POST` | `/api/merchant/group-buy-activities` | 商家建立團購 |
| `GET` | `/api/stores/:storeId/menu` | 讀取顧客可購買的上架菜單與客製化選擇限制 |
| `GET` | `/api/merchant/stores/:storeId/menu` | 商家讀取包含停售品項的完整菜單 |
| `POST` | `/api/merchant/stores/:storeId/menu-items` | 商家新增菜單品項與客製化規則 |
| `PATCH` | `/api/merchant/stores/:storeId/menu-items/:menuItemId` | 商家修改菜單品項、選項、明確選擇上限與販售狀態 |
| `POST` | `/api/orders` | 顧客建立訂單 |
| `POST` | `/api/orders/:orderId/revisions` | 建立已授權訂單的修改版本 |
| `GET` | `/api/orders/:orderId` | 讀取訂單明細 |
| `GET` | `/api/payment-rules/pickup-overdue` | 讀取付款前取餐與逾期未取規則全文／版本 |
| `DELETE` | `/api/admin/group-buy-activities/:activityId` | 管理員取消團購 |
| `POST` | `/api/admin/group-buy-activities/:activityId/settle` | 管理員手動觸發單一團購結算 |
| `POST` | `/api/payments/line-pay/request` | 保存訂單本人的現行規則同意後，建立 LINE Pay sandbox 授權請求 |
| `POST` | `/api/payments/line-pay/repay` | 請款失敗後，以結算金額建立 LINE Pay 直接付款 |
| `POST` | `/api/payments/line-pay/refund` | 管理員針對已請款交易建立 LINE Pay 退款 |
| `GET` | `/api/payments/line-pay/confirm` | LINE Pay redirect confirm |
| `GET` | `/api/payments/line-pay/cancel` | LINE Pay redirect cancel |

## Firebase Google Login

`POST /api/auth/firebase-session` is the primary auth route. The mobile app sends:

```json
{ "idToken": "firebase_id_token_from_google_login" }
```

The backend verifies the token with Firebase Admin SDK, looks up `users.firebase_uid`, resolves `user_roles` and `merchant_users`, then returns the existing bearer token response shape.

Required local backend env:

```env
FIREBASE_PROJECT_ID=your_firebase_project_id
GOOGLE_APPLICATION_CREDENTIALS=C:\local\secrets\firebase-service-account.json
AUTH_SESSION_SECRET=replace_with_backend_session_secret_at_least_16_chars
```

Do not commit the Firebase service account JSON. Each Firebase Google test account UID must be stored in `users.firebase_uid`.

## 開發測試登入

正式登入方向仍是 Firebase Google Login。若本機只有一個 Google 帳號，可把 `backend/.env` 設成 `AUTH_DEV_MODE=true`，並把 `mobile/.env` 設成 `EXPO_PUBLIC_AUTH_MODE=dev`；mobile 登入頁會顯示「本機測試身份」下拉選單，選項由目前 PostgreSQL runtime 內的有效顧客、商家與開發補救身份產生。

舊版帳密登入端點仍暫時保留作開發相容，但不屬於正式產品流程。

顧客使用「手機號碼 / 密碼」登入。

| 角色 | 手機號碼 / 密碼 |
| --- | --- |
| 顧客 A | `0911000001` / `customer1` |
| 顧客 B | `0911000002` / `customer2` |
| 顧客 C | `0911000003` / `customer3` |
| 顧客 D | `0911000004` / `customer4` |

商家使用「Email / 密碼」登入。

| 店家 | Email / 密碼 |
| --- | --- |
| 青山手作茶 中科店 | `store1@example.com` / `merchant1` |
| 晨露鮮奶茶 一中店 | `store2@example.com` / `merchant2` |
| 午後水果茶 雙十店 | `store3@example.com` / `merchant3` |
| 一中黑糖研究所 | `store4@example.com` / `merchant4` |
| 北區茶作館 | `store5@example.com` / `merchant5` |
| 柳川果茶室 | `store6@example.com` / `merchant6` |
| 雙十鮮乳坊 | `store7@example.com` / `merchant7` |

管理員使用「Email / 密碼」登入。

| 角色 | Email / 密碼 |
| --- | --- |
| 管理員 | `admin@example.com` / `admin1` |

登入成功後會取得 bearer token。建立訂單、查訂單、商家開團、LINE Pay request 都需要帶 token。

## LINE Pay 設定

LINE Pay sandbox 憑證放在：

```text
backend/.env
```

範例：

```env
LINE_PAY_ENV=sandbox
LINE_PAY_API_BASE_URL=https://sandbox-api-pay.line.me
LINE_PAY_MERCHANT_ID=your_merchant_id
LINE_PAY_CHANNEL_ID=your_channel_id
LINE_PAY_CHANNEL_SECRET=your_channel_secret
LINE_PAY_CURRENCY=TWD
LINE_PAY_CAPTURE_SEPARATED=false
LINE_PAY_AUTHORIZATION_SETTLEMENT_BUFFER_MINUTES=30
LINE_PAY_CONFIRM_URL=http://localhost:3000/api/payments/line-pay/confirm
LINE_PAY_CANCEL_URL=http://localhost:3000/api/payments/line-pay/cancel
AUTH_SESSION_SECRET=replace_with_backend_session_secret_at_least_16_chars
```

LINE Pay 台灣 channel 預設是自動請款。只有在 LINE Pay 已替該 channel 開通分離式請款後，才可把 `LINE_PAY_CAPTURE_SEPARATED=true`。未開啟時，後端會阻擋真 LINE Pay request，避免自動請款被誤當預授權。

分離式請款開啟後，後端會送出 `options.payment.capture=false`。Confirm 成功時若 LINE Pay 回傳 `authorizationExpireDate`，系統會保存到 `payment_authorizations.expires_at`，且到期時間必須晚於團購截止時間加 `LINE_PAY_AUTHORIZATION_SETTLEMENT_BUFFER_MINUTES`。

不要把 `backend/.env` commit 到 GitHub。

## 付款模組

LINE Pay 相關程式目前集中在：

| 檔案 | 用途 |
| --- | --- |
| `backend/payments/linePayClient.js` | 簽章並呼叫 LINE Pay API |
| `backend/payments/linePayService.js` | 串接訂單檢查、授權建立、confirm、cancel、void、capture 與 refund |
| `backend/payments/linePayPendingStore.js` | LINE Pay redirect 前後的記憶體快取；實際 confirm/cancel 以 DB 查找為主 |
| `backend/payments/reliabilityService.js` | provider reconciliation、持久化 retry job 與 worker lease |
| `backend/payments/settlementService.js` | 單一團購結算流程，依結果批次 capture / void |
| `backend/pickup/expirationService.js` | 掃描取餐期限並完成活動、標記逾期未取與寫入歷程 |
| `backend/pickup/pickupWindow.js` | 純計算：驗證取餐開始時間是否讓固定 3 小時取餐時段超過店家打烊時間、驗證團購截止時間是否落在打烊前 1 小時內 |

商家建立團購時，`deadlineAt` 必須晚於 `startAt`，且不得超過 `startAt` 後 24 小時。`pickupStartAt` 至少要晚於 `deadlineAt` 30 分鐘。`pickupEndAt` 不接受店家輸入，由後端固定算為 `pickupStartAt + 3 小時`（`backend/server.js` 的 `computeActivityPickupEndAt`）；若該店家 `stores.pickup_closing_time` 有設定，`pickupStartAt` 還不得晚於「打烊時間 − 3 小時」，否則回傳 409 `pickup_start_too_late_for_store_hours`；`deadlineAt` 也不得晚於「打烊時間 − 1 小時」，否則回傳 409 `deadline_too_close_to_store_closing`（兩條驗證彼此獨立，見 `backend/pickup/pickupWindow.js`，SQLite 與 PostgreSQL 兩條路徑都會檢查）。

本機可用 smoke script 驗證截止結算：

```powershell
npm run settlement:smoke
```

這個指令會備份並還原 `database/drink-group-buy-dev.sqlite`，中途使用乾淨 schema 建立 `mock_line_pay` 預授權資料，確認達標時 capture、未達標時依顧客選項 capture 或 void，驗證 scheduler 會抓到已截止團購、已授權訂單 revision 會在新授權成功後才套用並 void 舊授權，也會驗證失敗請款每 30 秒重試且最多建立三筆嘗試、取餐前 15 分鐘以前的手動重新付款與防重複入帳，以及全額退款與防重複退款。它不會呼叫外部 LINE Pay API，也不是正式付款流程。

後端啟動時會啟動 deadline settlement scheduler。預設每 30 秒掃描已截止、尚未結算的團購，並呼叫同一套 settlement service。相關設定：

```env
SETTLEMENT_SCHEDULER_ENABLED=true
SETTLEMENT_SCHEDULER_INTERVAL_MS=30000
SETTLEMENT_SCHEDULER_BATCH_SIZE=20
SETTLEMENT_SCHEDULER_ALLOW_PRODUCTION=false
```

若 `LINE_PAY_ENV=production`，scheduler 會被 production guard 擋下；必須明確設定 `SETTLEMENT_SCHEDULER_ALLOW_PRODUCTION=true` 才會啟動，避免意外真實請款。

LINE Pay request reconciliation worker 會掃描資料庫內 pending authorization、建立持久化 job，再用 lease claim 避免多個 Backend process 同時處理。

```env
PAYMENT_RECONCILIATION_ENABLED=true
PAYMENT_RECONCILIATION_INTERVAL_MS=15000
PAYMENT_RECONCILIATION_BATCH_SIZE=10
PAYMENT_RECONCILIATION_LEASE_MS=120000
PAYMENT_RECONCILIATION_MAX_ATTEMPTS=40
PAYMENT_RECONCILIATION_RETRY_INTERVAL_MS=30000
PAYMENT_RECONCILIATION_ALLOW_PRODUCTION=false
```

`NODE_ENV=production` 時，必須明確設定 `PAYMENT_RECONCILIATION_ALLOW_PRODUCTION=true` 才會啟動。Terminal job 會保存 `alert_required=1`，admin 可用 `GET /api/admin/payment-reliability/alerts` 查詢，scheduler 也會輸出結構化警示日誌，並透過 `backend/payments/alertNotifier.js` 呼叫 `ALERT_WEBHOOK_URL`（未設定時不送、不報錯，`npm test` 與 sandbox 環境本來就不會設這個變數）。這個 URL 是通用的 webhook（Slack／Discord／Mattermost 的 incoming webhook 都吃同樣的 `{"text": "..."}` JSON 格式，或接一個自訂的內部服務），不綁定特定通知服務；同一支模組也會在 scheduler 本身丟例外（不是單一 job 失敗，是整個排程掛掉）時發送。

本機可用以下指令驗證 job 去重、跨執行個體 claim、租約逾時接手、失敗告警旗標與 provider 狀態對帳：

```powershell
npm run payment-reliability:smoke
npm run payment-reliability:multiprocess
```

此測試只使用系統暫存 SQLite，不呼叫外部 LINE Pay API，也不修改開發資料庫。
`payment-reliability:multiprocess` 會啟動兩個獨立 Node.js 程序，驗證同一 job／operation lock 只能由一個程序取得，以及租約到期後可由其他程序接手。

PostgreSQL 版的對應驗收見 `database/README.md`（`npm run postgres-reliability:multiprocess`）——用真正獨立的 OS 程序、對一個真的在跑的 PostgreSQL 執行同一組 job queue／operation lock 情境，不是只驗證 SQL 語法本身。

## PostgreSQL runtime 垂直切片

目前本機開發 Backend 的業務資料以 PostgreSQL 為主要 runtime。各 repository 仍保留 SQLite 相容分支供隔離測試，但正式資料流程不雙寫，也不允許同一筆交易混用兩種資料庫。

- `backend/database/sqliteAdapter.js`
- `backend/database/postgresAdapter.js`
- `backend/database/index.js`
- `backend/database/repositories/storeMenuReadRepository.js`
- `backend/database/repositories/storeDirectoryReadRepository.js`
- `backend/database/repositories/groupBuyActivityReadRepository.js`
- `backend/database/repositories/authProfileReadRepository.js`
- `backend/database/repositories/groupBuyActivityWriteRepository.js`
- `backend/database/repositories/merchantMenuRepository.js`
- `backend/database/repositories/customerOrderWriteRepository.js`
- `backend/database/repositories/customerOrderReadRepository.js`
- `backend/database/repositories/paymentAuthorizationRequestRepository.js`
- `backend/database/repositories/paymentAuthorizationConfirmRepository.js`
- `backend/database/repositories/manualLinePayRepaymentRepository.js`
- `backend/database/repositories/paymentReliabilityJobRepository.js`（重用 `groupBuySettlementRepository.js` 的通用 job-queue 函式，同一張 `payment_reliability_jobs` 表依 `job_type` 區分）

本機開發 Backend 已永久使用 PostgreSQL。套用 PostgreSQL migrations／seed 並設定 `DATABASE_URL` 後，各 repository runtime 應一致設定為：

```env
STORE_MENU_READ_RUNTIME=postgres
STORE_DIRECTORY_READ_RUNTIME=postgres
GROUP_BUY_ACTIVITY_READ_RUNTIME=postgres
GROUP_BUY_ACTIVITY_WRITE_RUNTIME=postgres
MERCHANT_MENU_RUNTIME=postgres
CUSTOMER_ORDER_WRITE_RUNTIME=postgres
CUSTOMER_ORDER_READ_RUNTIME=postgres
PAYMENT_AUTHORIZATION_REQUEST_RUNTIME=postgres
PAYMENT_AUTHORIZATION_CONFIRM_RUNTIME=postgres
PAYMENT_AUTHORIZATION_CANCEL_RUNTIME=postgres
CUSTOMER_ORDER_CANCEL_RUNTIME=postgres
AUTH_PROFILE_READ_RUNTIME=postgres
MANUAL_LINE_PAY_REPAYMENT_RUNTIME=postgres
PAYMENT_RELIABILITY_JOB_RUNTIME=postgres
PAYMENT_CAPTURE_RUNTIME=postgres
GROUP_BUY_SETTLEMENT_RUNTIME=postgres
PICKUP_CREDENTIAL_RUNTIME=postgres
PAYMENT_REFUND_RUNTIME=postgres
ORDER_REVISION_RUNTIME=postgres
MERCHANT_ACTIVITY_CANCEL_RUNTIME=postgres
```

Backend 會要求 auth、公開菜單、活動讀取／寫入、商家菜單、訂單、付款、revision、refund、pickup 與 settlement repositories 一致使用 PostgreSQL。顧客建單、confirm、cancel redirect、一般 void 與顧客取消交易皆採 activity-first row lock；付款生命週期以 `operation_locks` 防止跨執行個體重複執行。SQLite 僅供有明確隔離 runtime 的相容性測試，不得與 PostgreSQL 混用於同一筆交易。

本機契約測試會驗證 SQLite 委派、adapter 與 PostgreSQL API 格式：

```powershell
npm run database-adapter:smoke
npm run store-menu-read:smoke
npm run group-buy-activity-read:smoke
npm run auth-profile-read:smoke
npm run group-buy-activity-write:smoke
npm run merchant-menu-write:smoke
npm run customer-order-write:smoke
npm run customer-order-read:smoke
npm run payment-authorization-request:smoke
npm run payment-authorization-confirm:smoke
npm run payment-authorization-cancel:smoke
npm run customer-order-cancel:smoke
npm run line-pay-confirm-service:smoke
npm run line-pay-cancel-service:smoke
npm run payment-capture:smoke
npm run line-pay-capture-service:smoke
```

設定本機 `DATABASE_URL` 並套用 PostgreSQL migrations 後，可執行：

```powershell
npm run postgres-runtime:smoke
npm run group-buy-activity-postgres-http:smoke
npm run auth-profile-postgres-http:smoke
npm run group-buy-activity-postgres-write-http:smoke
npm run merchant-menu-postgres-http:smoke
npm run customer-order-postgres-http:smoke
npm run payment-capture-postgres:smoke
```
PostgreSQL HTTP proofs 會建立臨時資料並自動清除；活動、菜單與顧客建單寫入 proof 都使用第二條連線持有對應 row lock，確認請求等待、釋放後整筆 transaction 成功。建單 proof 另驗證重複訂單、即時改價、容量拒絕、item／option snapshots、history 與 audit。

2026-08-20 已將本機 Backend 的全部 repository runtime 永久切換為 PostgreSQL，並以真實 PostgreSQL 16 驗證主要讀寫、付款、結算、改單、退款與取餐流程；詳細證據以 `PROGRESS.md` 與 `database/README.md` 的 2026-08-20 後續記錄為準。SQLite 保留作隔離測試，沒有雙寫。




後端也會啟動 pickup expiration scheduler。有效期限取 `pickupStartAt + 3 小時` 與 `pickupEndAt` 兩者較早者；到期後，已扣款但未取餐的訂單會標記為 `expired`，已取餐維持 `picked_up`，活動則更新為 `completed`。相關設定：

```env
PICKUP_EXPIRATION_SCHEDULER_ENABLED=true
PICKUP_EXPIRATION_SCHEDULER_INTERVAL_MS=30000
PICKUP_EXPIRATION_SCHEDULER_BATCH_SIZE=20
```

本機可用以下指令驗證取貨逾期與重複執行防護：

```powershell
npm run pickup-expiration:smoke
```

菜單客製化規則可用不清除既有資料的 migration 補入；執行前會自動備份 SQLite，完成後驗證完整性與外鍵：

```powershell
npm run db:migrate:menu-customizations
```

菜單與訂單權威驗證可使用隔離的暫存資料庫測試，不會改動目前開發資料：

```powershell
npm run menu-order:smoke
```

訂單列表、cursor、重複下單、取消鎖定與冪等可使用隔離資料庫驗證；HTTP route 與跨店權限可用開發資料庫的臨時副本驗證：

```powershell
npm run order-flow:smoke
npm run order-api:smoke
```

## 目前限制

- 管理員登入已設定：`/admin` 網頁後台（server-rendered HTML）支援共用密碼（`ADMIN_WEB_PASSWORDS`）與每人獨立的 Firebase 信箱密碼登入（`POST /admin/login/firebase`，需先被 `scripts/grant-admin-role.js` 授予 admin 角色）兩種登入方式；後台涵蓋退款審核、團購取消、商家申請審核、帳號角色切換，見 `docs/AI-architecture.md`「Authentication 與 authorization」段落。
- 已授權訂單修改 API、mobile 重新預授權、provider request status reconciliation 與持久化 retry job 已完成第一版；仍需更完整的錯誤提示與 sandbox 人工驗證。
- LINE Pay refund 目前只有管理員後端 API 與 smoke test，尚未做正式操作 UI、退款失敗重試 queue 與正式 sandbox 人工端對端測試。
- LINE Pay webhook 第一版不列為必要入口；付款同步先以 confirm/cancel redirect、資料庫狀態與後續 provider 狀態查詢為主。
- Deadline 自動結算已改用持久化 job，settlement、provider、cancel、repay 與 pickup 使用 DB lease；PostgreSQL 兩程序競爭／接管驗證已通過，仍需正式通知管道。
- 目前使用 PostgreSQL development database 與版本化 migration，尚未完成 production deployment、備份／還原演練及正式環境驗收。
- 顧客與商家菜單 API、商家菜單管理 mobile 第一版、明確客製化選擇上限及訂單後端價格重算已完成；仍需完整 Android 裝置 E2E 與更細的菜單異動衝突修正 UX。
- 取貨逾期排程、取貨憑證建立／驗證 API 與顧客／商家第一版串接已完成；仍需完整 Android E2E 與補救權限流程。
