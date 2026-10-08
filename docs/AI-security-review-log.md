# 安全審查記錄

這份文件記錄每次 `/security-review` 或手動安全審查的結果——誠實記錄「審查過什麼、發現什麼、還沒解決什麼」，不是給外部客戶看的正式報告，是給自己跟之後接手的人看的工作記錄。

跟 `DECISIONS.md` 一樣邊做邊記，不倒著補；每次審查完，不管有沒有發現問題都要記一筆（「沒發現問題」本身也是有價值的資訊，代表這個範圍審查過了）。

`/security-review` 的邊界：只檢查注入攻擊、身份驗證/授權、加密/機密資料、程式碼執行、資料外洩這五類，明確不包含 DoS、過時套件漏洞、塞進 AI prompt 的使用者內容這些——這些如果需要，要另外處理，不能指望這份記錄涵蓋。

---

## 範本（複製這段開始寫新的一筆）

```
## YYYY-MM-DD — 審查範圍

**範圍**：（例如：LINE Pay 退款流程改動、backend/payments/ 整個資料夾）
**觸發原因**：（例如：CLAUDE.md 規則自動觸發 / 手動要求 / 上線前檢查）

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 高/中/低 | file.js:行號 | ... | ... | 已修 / 待處理 / 評估後不修（原因） |

### 沒發現問題的部分
（列出審查過、但沒發現問題的範圍，跟上面的發現一樣重要——證明這塊真的被看過）
```

---

## 2026-08-11 — 付款／訂單修改／取貨憑證相關的未 commit 改動

**範圍**：`backend/payments/`（ecpayService.js、linePayService.js、refundRequestService.js）、`backend/database/repositories/`（含新檔案 orderRevisionRepository.js、paymentRefundRepository.js、pickupCredentialRepository.js）、`backend/pickup/`、`backend/db.js`、`backend/server.js`、`database/migrations/004_order_revision_refund_pickup_postgres.sql`
**觸發原因**：手動要求，針對目前工作目錄裡還沒 commit 的這批改動做審查
**方法**：讀完整 diff＋新檔案全文，並追過呼叫路徑（不只看 diff 片段），交叉驗證授權/歸屬檢查跟金額防竄改邏輯

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| SQL injection | 新／改動的查詢全部用參數化 `$1/$2...`，沒有把輸入字串拼進 SQL |
| 訂單修改權限 | `createPostgresOrderRevision` 有檢查 `order.customer_user_id`，route handler 也要求 `customer` 角色並用 `authUser.id`，別人的訂單改不到 |
| 金額竄改（改單後的 LINE Pay 授權） | `requestLinePayAuthorizationUnlocked` 跟 `createPostgresPendingAuthorization` 各自獨立驗證金額對得上 `revision.originalAmount`，兩層防護，客戶端傳的金額不會被直接信任 |
| 取貨憑證跨店存取（IDOR） | `findMerchantCredentialPostgres`／`markReadyPostgres` 都有透過 `merchant_users` 限定在自己店，別的店的取貨碼查不到也改不動 |
| 取貨碼隨機性 | 用 `node:crypto` 的 `randomInt`，是密碼學安全的亂數，不是可預測的 |
| Postgres/SQLite 執行模式不一致的路由繞過風險 | 有 boot-time 檢查，設定不一致會直接讓伺服器啟動失敗，不會讓程式帶著矛盾設定跑起來 |

**這次沒審查到的部分**：ECPay／LINE Pay 的 webhook 簽章驗證（`CheckMacValue`、confirm signature）這次沒有改動，所以沒有重新審查，不代表這塊沒問題，只是這次範圍沒碰到。

### 待人工評估（信心度不夠高，沒有列為正式發現）

**改單後，舊的付款授權沒有被明確作廢**（信心度約 4/10，不是確認的漏洞，是資料完整性上的疑慮）
- 位置：`backend/database/repositories/paymentAuthorizationConfirmRepository.js` 的 `confirmPostgresAuthorization`（約 145-197 行）
- 狀況：訂單改單產生新授權（A2）並確認後，程式沒有把原本的授權（A1，`revision.original_payment_authorization_id`）明確轉成作廢狀態——A1 理論上還留在 `authorized` 狀態
- 為什麼沒列為正式漏洞：目前範圍內查到的請款／作廢／取消查詢都是抓「同一張訂單裡最新一筆」（`ORDER BY created_at DESC LIMIT 1`），所以正常流程只會摸到 A2，沒找到會去撈全部 `authorized` 狀態授權的路徑，沒有具體的雙重請款情境可以指出來
- 如果你想順手補：在套用改單的同一個 transaction 裡，明確把 A1 轉成作廢/取消狀態，就算目前沒有真的能被利用的漏洞，這樣資料庫的狀態也會更誠實、少一個潛在風險

---

## 2026-08-13 — 修法覆核：A1 作廢邏輯（呼應 2026-08-11 那筆「待人工評估」）

**範圍**：`backend/database/repositories/paymentAuthorizationConfirmRepository.js`（單一檔案的改動）
**觸發原因**：CLAUDE.md 規則自動觸發——金流相關改動，修完後主動跑一次 `/security-review` 留記錄
**方法**：只審查這次的 diff，對照 `paymentAuthorizationCancelRepository.js` 既有的 `voidPostgresAuthorization` 模式判斷一致性，並追過 `order_id`／`customerUserId` 的來源鏈路確認沒有跨訂單風險

### 這次改了什麼
在 `confirmPostgresAuthorization` 套用改單、確認新授權（A2）的同一個 transaction 裡，加了：用 `FOR UPDATE` 鎖住舊授權（A1），如果還是 `authorized` 狀態就轉成 `authorization_voided`（含 `voided_at`、`failure_reason`、provider event、status history、audit log、取消 reliability job），完全複製既有 `voidPostgresAuthorization` 的欄位與副作用。

### 發現

沒有找到信心度達到門檻（8/10 以上）的新問題。

**原本的疑慮是否解決**：**是**。A2 轉成 `authorized`、套用改單、跟 A1 轉成 `authorization_voided`，三件事在同一個 Postgres transaction 裡，要嘛一起成功、要嘛一起失敗，不會再有 A1 卡在 `authorized` 狀態的空窗期。

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| 會不會作廢到別的訂單/別人的授權（IDOR） | `revision.original_payment_authorization_id` 在建立改單時就已經限定同一張訂單，訂單本身也已經檢查過 `customer_user_id`，A1/A2/改單三者永遠綁在同一張訂單，沒有客戶端能操控的路徑指到別人的授權 |
| 重複作廢／併發競爭 | 有 `status === 'authorized'` 才會作廢的判斷式（跟舊有的作廢函式邏輯一致），加上 `FOR UPDATE` 鎖跟外層「A2 不是 pending 就直接回傳」的 idempotent 保護，重跑或併發都不會重複作廢 |
| provider event 的 idempotency key 會不會撞號 | 新的 key 格式（用改單的 UUID 命名空間）跟現有其他格式不會撞，不會有稽核事件被意外吞掉的風險 |
| 鎖的順序會不會死鎖 | 跟既有的作廢邏輯一樣先鎖 activity 再鎖授權，順序一致 |
| 如果 A1 已經被請款（captured）會不會誤作廢 | 判斷式只處理 `authorized` 狀態，已經 captured 的不會被誤動 |

**這次沒審查到的部分**：範圍只有這一支檔案的這次 diff，沒有重新審查 8/11 那次涵蓋的其他檔案（ecpayService.js、pickup 相關等）——那些維持 8/11 記錄的結論，不代表這次又重新確認過一次。

---

## 2026-08-17 — 商家自助取消團購（新功能）

**範圍**：`backend/server.js`（新路由）、`backend/db.js`（`cancelGroupBuyActivity` 的 `actionType` 參數化＋三個新的 SQLite gateway 函式）、`backend/database/repositories/merchantGroupBuyActivityCancelRepository.js`（新檔案）、`backend/payments/merchantActivityCancelService.js`（新檔案）、mobile 端（`apiClient.js`／`AppNavigator.js`／`MerchantDashboardScreen.jsx`）
**觸發原因**：CLAUDE.md 規則自動觸發——新功能涉及付款授權撤銷，屬於高風險區域，完成後主動跑一次 `/security-review` 留記錄
**方法**：只審查這次新增的 diff／新檔案，對照既有 `POST /api/orders/:orderId/cancel` 與 `customerOrderCancelRepository.js` 的既有安全模式（角色檢查、歸屬檢查、參數化查詢）判斷一致性，並追過 `reason`／`:id` path param／`authUser` 從 HTTP 請求到資料庫寫入與撤銷授權呼叫的完整鏈路

### 發現

沒有找到信心度達到門檻（8/10 以上）的問題。

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| 商家能不能取消別家店的團購（IDOR／越權） | `canManageStore(authUser, activity.store_id)` 在讀到活動後、任何資料庫異動前就檢查；後續查詢訂單一律限定在已驗證過的 `activity_id`，商家碰不到別家店的訂單 |
| 角色檢查 | 路由要求 `authUser.roles.includes("merchant")`，跟既有 merchant 路由寫法一致 |
| 客戶端能不能偽造 `actorUserId`／`activityId`／idempotency key／`actionType` | `actorUserId` 一律來自驗證過的 `authUser.id`；`activityId` 來自 URL path，不受 body 覆寫；idempotency key 與 `actionType`（`merchant_cancel_group_buy_activity`／`merchant_cancel_order`）都是伺服器端組出來的常數，body 傳不進去 |
| SQL injection | 新增的 SQLite／Postgres 查詢全部用 `?`／`$n` 參數化，包含 `cancelGroupBuyActivity` 新參數化的 `actionType`，沒有字串拼接 |
| 截止前 30 分鐘鎖定窗口能不能繞過 | 判斷用 `businessClock.nowIso()`（伺服器時間），mobile 端的 `isWithdrawalLocked` 只是 UI 提示，後端有獨立重新檢查 |
| 撤銷付款授權會不會撤到別人的授權 | `voidLinePayAuthorization`／`voidEcpayAuthorization` 呼叫時的 `orderId` 都來自已經限定 `activity_id` 的 eligible 訂單清單，沒有客戶端可操控指到別筆授權的路徑 |
| API 回應會不會洩漏多餘資料 | 只回傳 `{ activity, cancelledOrderCount, failedOrderIds }`，內部呼叫 `getOrderDetail` 取得的付款細節沒有被帶進 HTTP 回應 |
| `reason` 欄位 | 檢查非空、一律走參數化寫入，沒有被拿去組 HTML 或執行，沒有注入面 |

**這次沒審查到的部分**：沒有重新審查既有的 `POST /api/orders/:orderId/cancel`／`customerOrderCancelRepository.js` 本身（這次 diff 沒有動它們，只是拿來對照），也沒有涵蓋 admin 的 `DELETE /api/admin/group-buy-activities/:id` 路徑（這次功能刻意不修它，取消功能本身不完整——只改活動狀態、沒有連動訂單／授權——是已知但這次範圍外的資料完整性問題，不是這次新增的安全漏洞）。

---

## 2026-08-18 — 商家自助取消團購 code review 修正批次

**呼應**：2026-08-17 那筆（商家自助取消團購新功能）——這次是針對 `/code-review` 抓出的問題做修正後的複查，不是全新功能，範圍聚焦在這批修正本身有沒有新增漏洞
**範圍**：`backend/database/repositories/merchantGroupBuyActivityCancelRepository.js`（新增 `cancelPostgresActivityStatus`、`withOperationLock`）、`backend/payments/merchantActivityCancelService.js`（活動狀態改走 repository、per-order lock 改由 repository 內部決定、取消迴圈改成 `Promise.allSettled` 平行處理）、`backend/db.js`（`cancelMerchantOrderInDatabase` 補上逐筆 `status_history`／`payment_reliability_jobs` 清理）、`backend/server.js`（Postgres 全面切換一致性檢查加入新 repository）、`mobile/src/utils/fetchWithTimeout.js`（新檔案，取代原本會導致當機的 `AbortController` 逾時寫法）、`mobile/src/screens/MerchantDashboardScreen.jsx`（取消按鈕加同步防連點）、`mobile/src/screens/PaymentAuthorizationScreen.jsx`（取餐規則同意加「必須展開閱讀過」的檢查）
**觸發原因**：CLAUDE.md 規則自動觸發——這批修正動到付款授權撤銷與訂單取消的鎖定機制，屬於高風險區域

### 發現

沒有找到信心度達到門檻（8/10 以上）的問題。

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| `cancelPostgresActivityStatus` 有沒有重新做歸屬檢查、會不會被繞過 | 沒有在函式內重做，但確認唯一呼叫者（service 層）在任何寫入動作前就已經用同一個 `activityId` 做過 `canManageStore` 檢查，中間沒有客戶端可操控、會讓兩處 `activityId` 不一致的路徑 |
| repository 內部決定 lock 機制（原本是 service 層依 `paymentAuthorizationCancelRepository.kind` 分支）會不會讓兩個 repository 的 runtime 不一致、鎖不到同一把鎖 | `backend/server.js` 的 Postgres 全面切換一致性檢查已把新 repository 納入，任一 repository 切到 postgres 就強制全部都要是 postgres，不可能出現兩邊 runtime 不同步的狀態 |
| `fetchWithTimeout.js` 用 URL 當 key 做 in-flight 去重，會不會讓不同使用者的回應被互相搭到 | 兩個呼叫點分別是固定 URL（無使用者資料）跟帶 `userId` 查詢參數的 URL，不同使用者天生產生不同 key；且這個快取只存在單一 client 自己的 JS runtime，不是伺服端共享狀態 |
| 取消迴圈改成平行處理（`Promise.allSettled`）會不會讓原本序列處理下不會發生的跨訂單互相干擾冒出來 | 每筆訂單各自有獨立的 per-order lock 與 idempotency key，彼此沒有共用可變狀態；活動層級的最終狀態寫入本身是原子、冪等的，平行處理前後結果一致 |
| `cancelMerchantOrderInDatabase` 新增的逐筆 `status_history`／`payment_reliability_jobs` 寫入 SQL | 全部走 `?` 綁定參數，沒有字串拼接 |

**這次沒審查到的部分**：沒有重新審查 2026-08-17 那次已經涵蓋的範圍（角色檢查、`reason` 驗證、撤銷授權的訂單歸屬等），只聚焦在這批新增/修改的程式碼本身。

---

## 2026-08-20 — PostgreSQL 遷移三個新切片（店家清單／訂單編輯／LINE Pay 人工重新請款）

**範圍**：`backend/database/repositories/storeDirectoryReadRepository.js`（新檔案，唯讀）、`backend/database/repositories/customerOrderWriteRepository.js`（新增 `updateOrder`／`updatePostgresPendingOrder`）、`backend/database/repositories/manualLinePayRepaymentRepository.js`（新檔案，含 `getPostgresRepaymentContext`、`completePostgresRepayment`）、`backend/payments/linePayService.js`（`requestManualLinePayRepayment`／`requestManualLinePayRepaymentUnlocked`／`confirmLinePayAuthorizationUnlocked` 改為接受並使用注入的 repository）、`backend/server.js`（建構三個新/擴充的 repository、路由改走 repository、新增兩處 Postgres 全面切換一致性檢查、`isSqliteOrderDependentRoute` 白名單新增 `PATCH /api/orders/:orderId`）
**觸發原因**：CLAUDE.md 規則自動觸發——這批動到訂單金額重算、付款預授權作廢與人工重新請款的請款/確認邏輯，屬於高風險區域
**方法**：讀完整 diff 與兩個新檔案全文（不只看 diff 片段），交叉比對既有 repository（`paymentAuthorizationCancelRepository.js`、`customerOrderReadRepository.js`）已經確立的 row lock／冪等／授權檢查慣例，追查所有新 SQL 的參數化與 HTTP request body 到 SQL 的資料流

### 發現

沒有找到信心度達到門檻（8/10 以上）的問題。

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| 新 SQL 有沒有字串拼接、繞過參數化 | 全部走 `$1/$2...` 參數化；唯一出現在 SQL 文字裡的 `${...}` 樣板字串都是綁進參數的 `randomUUID()` 產生的 ID，不是拼進 SQL 語法本身 |
| `updatePostgresPendingOrder` 會不會被拿去改別人的訂單 | 寫入前檢查 `order.customer_user_id === input.customerUserId`，且用 `FOR UPDATE` 鎖住 `orders`／`group_buy_activities` 兩張表，跟 `createPostgresCustomerOrder` 用同一把活動列鎖，容量檢查不會跟建單流程互相搶跑 |
| 訂單編輯會不會繞過重新計價／折扣／容量驗證 | 重用既有 `pricePostgresOrderItems`／`validatePostgresOrderDiscount`，任何價格不符、折扣衝突、超過容量都回結構化錯誤、不寫入 |
| `completePostgresRepayment` 會不會被重複觸發、造成重複請款 | 鎖住 authorization 列（`FOR UPDATE`），只接受 `direct_repayment`＋`pending` 狀態；用 `UPDATE ... WHERE status = 'pending'` 搭配 `rowCount` 檢查達成冪等，`payment_provider_events` 另外用 `ON CONFLICT (idempotency_key) DO NOTHING` |
| 請款金額能不能被竄改 | 嚴格比對 `amount === authorization.original_amount`，不接受任何容差或前端自報的覆寫值 |
| 新的一致性檢查（`manualRepaymentPostgresReady`）會不會讓人工重新請款用 postgres、但確認/取消還在 sqlite，造成兩邊資料不同步 | 這個檢查要求 `customerOrderWriteRepository` 也必須是 postgres，而既有的全面切換檢查已經把 `paymentAuthorizationConfirmRepository`／`paymentAuthorizationCancelRepository` 綁進同一組，不可能出現人工重新請款走 postgres、但確認／取消還在 sqlite 的分裂狀態 |
| `storeDirectoryReadRepository` 的 postgres 版本會不會洩漏比原本 SQLite 版本更多的欄位 | 回傳欄位（`id, name, address, phone, business_status, latitude, longitude`）跟既有 SQLite `listPublicStores()` 完全一致 |
| `isSqliteOrderDependentRoute` 這次的白名單異動，會不會不小心放行了還沒真正接上 postgres 的路由 | 這次只放行了確實已經完整改走 repository 的 `PATCH /api/orders/:orderId`；`POST /api/payments/line-pay/repay`（發起新的人工重新請款）內部還有 3 處未接上 repository 的直接呼叫，維持原本的擋停，沒有放行 |

**這次沒審查到的部分**：`POST /api/payments/line-pay/repay` 內部尚未接上 repository 的三處直接呼叫（已請款和解、建立新預授權、對帳排程）本身不在這次改動範圍內，維持原樣未動，等下一輪處理時再審查。**〔2026-09-13 補註：已於下一筆記錄（同日「LINE Pay 對帳背景排程 PostgreSQL 支援」）處理完畢，見該筆內容；目前 `linePayService.js` 的 `requestManualLinePayRepaymentUnlocked` 三處都已接上對應 repository（有給就走 repository、沒給才 fallback SQLite），`server.js` 呼叫時也已把五個 repository 全部傳入，此項不再是待處理狀態。〕**

---

## 2026-08-20 — LINE Pay 對帳背景排程 PostgreSQL 支援（呼應上一筆「這次沒審查到的部分」）

**呼應**：同一天稍早那筆（PostgreSQL 遷移三個新切片）——那筆結尾明講「`POST /api/payments/line-pay/repay` 內部三處未接上 repository 的直接呼叫...等下一輪處理時再審查」，這筆就是那個下一輪
**範圍**：`backend/database/repositories/paymentReliabilityJobRepository.js`（新檔案，重用 `groupBuySettlementRepository.js` 已審查過的通用 job-queue 函式）、`backend/database/repositories/groupBuySettlementRepository.js`（新增匯出 `completePostgresSettlementJob`／`mapJob`，函式本身不變）、`backend/payments/reliabilityService.js`（整支改寫成接受注入 repository）、`backend/payments/linePayService.js`（`requestManualLinePayRepaymentUnlocked` 補上三個 repository 注入、`requestLinePayAuthorizationUnlocked` 移除舊有「postgres 模式下跳過排入對帳工作」的防呆）、`backend/server.js`（建構新 repository、路由改走 repository、新增一致性檢查、排程啟動條件改為動態判斷）
**觸發原因**：CLAUDE.md 規則自動觸發——這批動到付款確認/取消/請款的背景重試與人工重新請款發起流程，屬於高風險區域

### 發現

用一個 sub-task 找候選漏洞，人工複查每一個候選（未额外拆分平行 false-positive sub-task，因為兩個候選都已經用 grep／實際讀取程式碼直接證實為真，不是需要額外驗證才能判斷的推測性問題）：

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 高 | `backend/server.js`（`POST /api/payments/line-pay/request` route） | 移除舊防呆（`if (kind !== "postgres") { enqueue }`）改成一律呼叫 `enqueuePendingAuthorizationReconciliation`，但這個主要付款請求路由的呼叫沒有把新的 `reliabilityJobRepository` 傳進去；沒收到就會走 `undefined ? ... : 直接呼叫 SQLite`的 fallback，等於所有主流程建立的授權，對帳保護工作都固定寫進 SQLite，就算全站已經切到 PostgreSQL 也一樣，而且不會有任何錯誤或警告 | 在該路由呼叫 `requestLinePayAuthorization({...})` 時比照 `/repay` 路由，補上 `reliabilityJobRepository` | 已修 |
| 中 | `backend/server.js`（新的 `reconciliationPostgresReady` 一致性檢查） | 原本的檢查只往一個方向驗證（`reliabilityJobRepository` 是 postgres、但其他三個不是才會擋），沒有驗證反過來的狀況：其他三個都切到 postgres、但忘記設定新的 `PAYMENT_RELIABILITY_JOB_RUNTIME`——這種情況伺服器會正常啟動，只是背景排程被靜默停用，沒有任何啟動錯誤提示 | 把觸發條件改成「四個裡面只要有任何一個是 postgres、但沒有全部都是 postgres」就擋停 | 已修 |

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| 對帳背景工作（沒有登入使用者、代表系統執行）會不會確認/請款/作廢到錯誤訂單、或金額被竄改 | job payload 裡的 `orderId`／`amount` 只用來查詢，實際寫入金額一律重新從資料庫查出的權威 context 取得，不採信 payload 裡的值 |
| 重用「團購結算」排程的通用 job-queue 函式，會不會讓不同 job_type 搶到／完成／重排到彼此的工作 | claim 用 `FOR UPDATE SKIP LOCKED` 且 `WHERE job_type = $1` 限定範圍；complete／reschedule 用 `id + locked_by = workerId` 精確鎖定單一列，`id` 是 claim 時產生的全域唯一值，不會跨 job_type 誤觸 |
| `paymentReliabilityJobRepository.js` 兩個新查詢（`listPostgresPendingLinePayAuthorizations`、`listPostgresPaymentReliabilityAlerts`）的 SQL injection | 全部走 `$1/$2/$3` 參數化 |
| 監控告警端點（`GET /api/admin/payment-reliability/alerts`）改走 repository 後，權限檢查有沒有被繞過 | admin 角色檢查邏輯完全沒動，只有資料來源從直接呼叫改成透過 repository |

**這次沒審查到的部分**：`confirmLinePayAuthorizationUnlocked` 裡處理訂單修改（revision）替換舊授權時呼叫 `voidLinePayAuthorization` 沒有傳入 `authorizationCancelRepository`，會一律走 SQLite——但這是這次改動之前就存在的既有程式碼（沒有被這次 diff 動到），不算這次改動新增的問題，記錄下來留給之後處理 revision 相關 PostgreSQL 支援時一併處理。

---

## 2026-08-20 — ECPay 核心付款流程 PostgreSQL 支援

**範圍**：`backend/database/repositories/ecpayAuthorizationRepository.js`（新檔案，含 `getLatestPostgresEcpayAuthorizationForOrder`、`createPostgresPendingEcpayAuthorization`、`withPostgresEcpayOperationLock`；請款/作廢/確認回跳的核心邏輯改為交叉重用既有 `paymentCaptureRepository.js`／`paymentAuthorizationCancelRepository.js`／`paymentAuthorizationConfirmRepository.js`／`paymentRefundRepository.js` 已審查過的函式）、`backend/payments/ecpayService.js`（`requestEcpayAuthorization`／`renderEcpayCheckoutRedirectHtml`／`handleEcpayReturnWebhook`／`captureEcpayAuthorization`／`voidEcpayAuthorization`／`withEcpayOperationLock` 改為接受並使用注入的 repository）、`backend/payments/settlementService.js`／`backend/payments/merchantActivityCancelService.js`（結算與商家取消團購呼叫 ECPay 請款/作廢時，新增三個相依 repository 是否同時切齊 postgres 的執行期防呆）、`backend/server.js`（建構新 repository、四個路由改走 repository、新增一致性檢查 `ecpayPostgresReady`、路由白名單新增 `client-back`／有條件放行 `request`／`checkout-redirect`／`return`）、`backend/database/repositories/paymentAuthorizationRequestRepository.js`（修正一個既有 LINE Pay Postgres 缺陷）、`backend/database/repositories/paymentRefundRepository.js`（新增匯出 `getLatestProviderEventPayloadPostgres`，函式本身不變）
**觸發原因**：CLAUDE.md 規則自動觸發——這批動到信用卡請款、作廢授權、webhook 確認回跳的核心付款邏輯，屬於高風險區域
**方法**：用一個 sub-task 找候選漏洞（給完整 diff、四個核心檔案全文、以及本次重用函式的來源檔案全文），該候選未額外拆分平行 false-positive sub-task驗證——因為候選本身已經透過直接讀取 `backend/db.js` 源頭邏輯、比對既有 LINE Pay Postgres 對應函式、寫一個能重現問題的 repository 層 regression test 三種方式交叉證實為真，不是需要額外驗證才能判斷的推測性問題

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 高 | `backend/database/repositories/ecpayAuthorizationRepository.js`（`createPostgresPendingEcpayAuthorization`） | 建立待確認授權時有對 `orders` 資料表下 `FOR UPDATE` 鎖，但鎖到之後沒有拿鎖到的 `original_amount` 跟請款金額比對，就直接把請款金額寫進新的 `payment_authorizations` 列——如果在「`ecpayService.js` 檢查金額」跟「這個交易真正鎖住訂單」中間，剛好有一次訂單編輯（`PATCH /api/orders/:orderId`）改了金額，就會留下一筆金額跟訂單當下實際金額不一致的授權紀錄；`backend/db.js` 的 SQLite 版本本來就沒有這個檢查（甚至訂單讀取根本不在交易內），但既有 LINE Pay Postgres 對應函式（`createPostgresPendingAuthorization`）確實有做這個檢查，這次新寫的 ECPay 版本一開始因為「忠實比照 SQLite 原始邏輯」而漏掉了 | 在拿到 `FOR UPDATE` 鎖之後、寫入前，比照既有 LINE Pay Postgres 版本補上金額比對，不符就回傳 `null`；呼叫方（`ecpayService.js`）原本收到 `null` 會靜默回傳「成功」但 `authorization: null`，一併補上明確的 409 錯誤，不管 SQLite 或 PostgreSQL 路徑都適用 | 已修，並新增 repository 層 regression test（`verifyPostgresCreatePendingAuthorizationRejectsStaleAmount`）覆蓋這個情境 |

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| 新 SQL 有沒有 SQL injection | `ecpayAuthorizationRepository.js` 全部新 SQL，以及這次重用的既有 Postgres 函式，全部走 `$1/$2...` 參數化，沒有字串拼接 |
| 訂單歸屬與角色檢查 | `requestEcpayAuthorizationUnlocked` 的 `order.customerUserId !== authUser.id && !admin` 檢查，SQLite／PostgreSQL 兩條路徑完全相同，沒有被這次改動弱化 |
| 請款／作廢／確認回跳會不會用錯 provider 或錯的授權列 | 重用的 `getPostgresAuthorizationContext`／`capturePostgresAuthorization`／`voidPostgresAuthorization` 一律用明確傳入的 `provider` 參數 + `FOR UPDATE` 精確鎖定，這次新增的 ECPay 呼叫方沒有弱化這些檢查 |
| `ECPAY_AUTHORIZATION_RUNTIME`／`PAYMENT_CAPTURE_RUNTIME`／`PAYMENT_AUTHORIZATION_CANCEL_RUNTIME` 三個獨立開關沒切齊時，會不會讓請款/作廢悄悄查到錯的 runtime、查無資料被當成沒事 | `server.js` 開機時擋停「`ecpayAuthorizationRepository` 是 postgres、但另外兩個不是」的組合；`settlementService.js`／`merchantActivityCancelService.js` 在每次實際呼叫請款/作廢前，另外重新核對三者是否同時為 postgres，沒有同時切齊就整批退回 SQLite（而不是只退回其中一兩個），逐一追過所有呼叫點沒有找到會悄悄查錯 runtime 的組合 |
| webhook（`handleEcpayReturnWebhook`）能不能被重放造成重複請款/授權 | `verifyEcpayCheckMacValue` 簽章驗證與重用的 `confirmPostgresAuthorization` 內建 `status !== 'pending'` 提早回傳（不是靠 idempotency key），兩層防護都沒有被這次改動動到 |
| 機密與硬式編碼憑證 | 沒有新增任何硬式編碼金鑰、密碼或簽章繞過 |

**這次額外發現、但不屬於本次 diff 範圍的既有問題**：`linePayService.js` 的 `requestLinePayAuthorizationUnlocked`（LINE Pay 主要請款流程本身）呼叫 `createPendingAuthorization` 後沒有檢查回傳是否為 `null`，跟這次修正前的 ECPay 版本是同一種缺口；同檔案的人工重新請款流程（`requestManualLinePayRepaymentUnlocked`）則已經有做這個檢查。這次沒有動 `linePayService.js` 的這段邏輯，記錄下來留給之後處理 LINE Pay 請款流程時一併評估是否要補上。

---

## 2026-08-20 — 三個已知缺口修正＋本機全面切換 PostgreSQL 過程中發現的問題

**呼應**：同一天稍早三筆記錄裡各自標記「待處理」的既有缺口——「改單替換舊授權未接上 PostgreSQL repository」「主要請款流程缺少建立失敗檢查」「管理員舊版取消團購工具資料不完整」，這筆是修正這三個
**範圍**：`backend/payments/linePayService.js`（`voidReplacedAuthorizationIfNeeded` 補上 `authorizationCancelRepository` 注入；`requestLinePayAuthorizationUnlocked` 對 `createPendingAuthorization` 回傳 `null` 補上明確錯誤）、`backend/payments/merchantActivityCancelService.js`（`cancelMerchantGroupBuyActivity` 的 `actionType` 改為可由呼叫方指定）、`backend/server.js`（管理員 `DELETE /api/admin/group-buy-activities/:id` 改為重用 `cancelMerchantGroupBuyActivity` 而非直接呼叫只改活動狀態的舊函式；回應改為轉發完整結果而非只回傳 `activity`）、`backend/database/repositories/paymentReliabilityJobRepository.js`／`manualLinePayRepaymentRepository.js`／`merchantGroupBuyActivityCancelRepository.js`（修正 `authorization` 這個 PostgreSQL 保留字被當作裸 SQL別名的問題）
**觸發原因**：CLAUDE.md 規則自動觸發——這批動到付款作廢、訂單取消層級的核心邏輯，屬於高風險區域；同時本機首次把 backend 所有 21 個 `*_RUNTIME` 開關一次切到 PostgreSQL 做完整驗證時，額外發現了下面幾個問題

### 發現（本次修正的既有缺口 + 這次改動本身的審查）

用一個 sub-task 找候選漏洞，人工複查每一個候選：

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 中 | `backend/server.js`（管理員取消團購路由） | 改用 `cancelMerchantGroupBuyActivity` 後，回應只回傳 `{ activity: result.activity }`，把 `cancelledOrderIds`／`cancelledOrderCount`／`failedOrderIds` 都丟掉了——如果底下某張訂單的作廢呼叫失敗（例如 provider 端暫時打不通），活動本身還是會被標記取消，但管理員收到的回應是普通的 200，跟全部成功時看起來一模一樣，等於重新製造了一個範圍更小、但性質相同的「看起來成功、實際上資料沒對齊」問題 | 改成直接轉發 `cancelMerchantGroupBuyActivity` 的完整回傳結果 | 已修 |
| 中 | `backend/payments/merchantActivityCancelService.js`（`cancelMerchantGroupBuyActivity`，未修改既有邏輯，重新被管理員路由呼叫後才顯現） | 這個函式原本只給商家自助取消用，內建兩條商家專屬限制（活動必須是 `recruiting` 狀態；截止前 30 分鐘鎖定視窗）。管理員舊工具原本沒有這兩條限制、可以無條件取消。改用這個函式後，管理員取消團購也會被這兩條擋下來——已知且刻意接受的取捨：新行為換來的是正確的訂單/授權連動處理，舊行為（無條件改狀態、完全不處理訂單付款）本身就是這份記錄從一開始要修的問題根源，繼續保留「無條件」等於保留原本的資料不一致風險。沒有另外做管理員專屬的略過選項 | 目前維持這個限制，不做略過選項；如果之後確定管理員需要在非 `recruiting` 狀態或截止前 30 分鐘內強制取消，需要另外設計一個明確的管理員覆蓋機制（同時仍要跑訂單/授權連動），不是恢復舊的無條件行為 | 已記錄為已知取捨，未修改（刻意維持） |

### 過程中發現、不屬於這批程式改動本身、但同樣重要的基礎設施問題

這兩個不是「程式邏輯」的安全漏洞，是本機第一次把所有切片同時打開、對一個真的在跑的 PostgreSQL 執行時才會現形的問題，值得記錄避免以後重複踩到：

1. **`authorization` 是 PostgreSQL 保留字，不能當裸別名**：`SELECT authorization.id FROM payment_authorizations authorization` 這種寫法在真的 PostgreSQL 上會直接噴 `syntax error at or near "."`；先前這幾支查詢只被套過假的 mock 資料庫測試（只比對 SQL 文字，不會真的解析執行），從沒被真的 PostgreSQL 解析過，所以這個問題一直沒被抓到。影響到 `paymentReliabilityJobRepository.js`（`listPostgresPendingLinePayAuthorizations`）、`manualLinePayRepaymentRepository.js`（`getPostgresRepaymentContext`，改名 `original_payment_auth`）、`merchantGroupBuyActivityCancelRepository.js`（`listPostgresEligibleOrders`，改名 `payment_auth`）三支既有檔案裡的查詢，全部已改用不會撞保留字的別名並重新驗證通過。
2. **`005_order_rule_consents_postgres.sql` 從沒被真的套用到本機開發資料庫**：只有 migration runner 自己的獨立 smoke test（用完即丟的 throwaway schema）驗證過套用結果，`schema_migrations` 實際只記錄到 `004`。已執行 `npm run postgres:migrate` 補上。

### 驗證方式

- 修正後 `npm test` 59/59、既有 repository/service smoke test 全數重跑通過。
- 三個管理員取消路由的修正，直接對本機真實 PostgreSQL 16 用真實 HTTP 流程驗證：建立真的活動與訂單、模擬已授權付款、呼叫真的管理員取消 API、直接查資料庫確認訂單被取消、付款預授權被作廢、audit log 正確記錄 `admin_cancel_group_buy_activity`（先用真實 LINE Pay provider 驗證到「作廢呼叫真的有觸發、失敗時正確回報 `failedOrderIds`」；再用 `mock_line_pay` provider 驗證完整成功路徑）。
- 把本機 backend 全部 21 個 `*_RUNTIME` 開關切到 `postgres`，跑過完整寫入流程（建團、建單、LINE Pay 請款、商家菜單、改單）與既有 `*-postgres-http-smoke` 系列，過程中資料庫內容執行前後一致，測試資料均已清除。

**這次沒完全查清楚、記錄下來的觀察**：測試過程中曾在一次 LINE Pay 作廢呼叫失敗（provider 回傳「Transaction record not found」，這是測試手法本身的產物——手動把訂單狀態直接改成已授權、沒有真的走過 LINE Pay confirm）時，看到一次 `pg` 套件的 deprecation warning：「Calling client.query() when the client is already executing a query」。後續重跑同樣情境與大量其他測試都沒有再出現，懷疑是跟背景對帳排程（每 15 秒一次）在時間點上的巧合，還沒有辦法穩定重現、也還沒找到確切原因。目前是 deprecation warning、不是硬性錯誤，但未來 `pg` 主版本升級後可能變成真的錯誤，值得之後有人重現時再深入排查。

**後續補充（同日）**：原本驗證完把 `backend/.env` 切回 SQLite；使用者確認要把本機開發環境永久改成跑在 PostgreSQL 上。永久切換前，找出 `backend/.env` 是全域生效（透過 `backend/auth.js` 的 `loadLocalEnv`，任何間接用到登入相關程式碼的獨立腳本都會載入，不只 backend 伺服器本身），逐一檢查所有用 `sqliteGateway` 建構 repository 的獨立測試腳本（11 支），確認只有 `scripts/merchant-activity-cancel-service-smoke.js` 沒有明確用 `env: {}` 隔離、會被悄悄導去查真實 PostgreSQL（其餘 10 支本來就已經隔離），已修正並重新驗證。這不是這次改動本身新增的安全漏洞（純粹是測試環境隔離問題，不影響正式程式邏輯），記錄在這裡是為了跟上面同一批工作的脈絡銜接完整。永久切換後，`npm test` 與全部相關 smoke test／HTTP proof 已重新驗證通過。

---

## 2026-08-15 — dev-only 全域業務時間與付款／取餐時限串接

**範圍**：`backend/time/businessClock.js`、`backend/server.js`、`backend/db.js`、`backend/payments/linePayService.js`、`backend/payments/settlementService.js`、`backend/pickup/credentialService.js`、`backend/pickup/expirationService.js`、受影響 activity/order repositories，以及本機 `local-dev-console/` 修改入口
**觸發原因**：全域規則自動觸發——本次改動會影響授權確認、截止結算與取餐逾期的時間判斷
**方法**：讀完整本次 diff 與業務時鐘全文，追查 API 修改權限、付款 provider 呼叫與資料庫確認、scheduler、operation lock、取餐碼 rate limit 的時間來源；另執行單元測試與獨立 Backend HTTP smoke

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 中 | `backend/payments/settlementService.js:30`、`backend/pickup/credentialService.js:13` | 初版串接讓 operation lease 跟著模擬時間；固定時間可能讓鎖無法正常逾時，切換時間也可能扭曲併發保護 | 業務期限使用 business time，但鎖的建立／到期一律保留真實時間 | 已修 |
| 中 | `backend/pickup/credentialService.js:288` | 初版讓取餐碼失敗次數視窗跟著模擬時間；倒退或固定時間可能延長／繞過限流視窗 | rate limit 獨立使用真實時間，只讓憑證有效期與核銷業務時間使用模擬值 | 已修 |
| 低 | `local-dev-console/server.js:315` | 僅靠 loopback 仍可能讓其他網頁從使用者瀏覽器跨來源呼叫本機控制台修改時間 | mutation 檢查 `Origin`，只接受本機控制台同來源；Backend PUT 同時維持 dev gate 與 loopback 限制 | 已修 |

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| Production 暴露 | route 只有非 production 且 `AUTH_DEV_MODE=true` 時存在；`PUT` 另要求 Backend 主機 loopback，production 即使傳入 payload 也不能修改 clock |
| 輸入與資源濫用 | mode 使用白名單；offset 必須為整數；offset／fixed 都限制在真實伺服器時間前後 7 天；狀態只存在記憶體且重啟恢復 |
| 帳號與權限 | 沒有修改 Firebase UID、`user_roles`、merchant permission 或 bearer token 驗證；Mobile 只有 GET，沒有時間修改 API |
| 金額竄改 | 沒有更動訂單／付款金額計算；授權確認仍使用 Backend 資料庫金額，client 無法用時間 payload 帶入金額 |
| Provider 機密與簽章 | 沒有記錄 API key、secret 或完整 provider payload；Firebase、token、LINE Pay／ECPay request、簽章與 webhook clock 未改用 business time |
| 非預期直接扣款 | `PUT /api/dev/business-time` 只更新記憶體狀態，不直接呼叫 capture／void；排程只會在原本下一次 interval 依新時間檢查，production capture guard 維持不變 |
| 資料注入 | 新 endpoint 不建立 SQL 字串；既有資料庫操作仍使用原來的參數化查詢，時間值由 Backend 產生並經 ISO 正規化 |

**驗證限制**：這次沒有呼叫真實 LINE Pay／ECPay 網路，也沒有執行會重建開發 SQLite 的付款 smoke；只驗證業務時鐘單元行為、Backend route 切換／還原與程式串接。真實 provider E2E 結論仍以既有 checklist 為準。

---

## 2026-08-15 — 顧客／商家付款狀態顯示文案分離

**範圍**：`mobile/src/types/prototypeTypes.js`、`mobile/src/components/StatusBadge.jsx`、`mobile/src/screens/GroupProgressScreen.jsx`、`mobile/src/screens/MerchantDashboardScreen.jsx`、`mobile/tests/paymentStatusLabels.test.mjs`
**觸發原因**：金流相關 Mobile 顯示修改，依專案規則完成後進行聚焦安全複查
**方法**：讀取完整付款文案 diff，確認狀態來源、顧客／商家 owner 選擇、顯示色彩與測試；交叉確認沒有改動 Backend、付款金額、provider 呼叫或權限判斷

### 發現

沒有發現安全問題。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 金額竄改 | 只修改狀態 label 與呈現色彩，沒有改動 `originalAmount`、`authorizedAmount`、`captureAmount` 或折扣計算 |
| 狀態竄改 | `authorized`／`captured`／`failed` 等資料仍來自既有 Backend／Mobile state；沒有新增 client-side 狀態轉移或把顯示文案回寫後端 |
| 身份與授權 | 顧客／商家差異由畫面既有 owner 選擇決定，沒有修改登入、角色解析、商家店家權限或 API 存取控制 |
| 機密與資料外洩 | 新增測試只讀取靜態文案模組，不讀取 `.env`、token、交易編號或顧客資料 |
| 程式碼執行 | 測試透過本機既有靜態來源建立 ESM data URL，不接受使用者輸入，也不執行外部或下載內容 |

**驗證限制**：`npm test` 42 項與 Mobile 語法解析已通過；尚未在 Android 顧客／商家實際畫面人工確認排版，因此 UI E2E 仍列為待處理。

---

## 2026-08-15 — LINE Pay 付款前取餐／逾期未取規則同意

**範圍**：`backend/payments/orderRuleConsent.js`、`backend/payments/linePayService.js`、`backend/database/repositories/paymentAuthorizationRequestRepository.js`、`backend/db.js`、`backend/server.js`、`database/schema.sql`、`database/migrations/005_order_rule_consents_postgres.sql`、`mobile/src/screens/PaymentAuthorizationScreen.jsx`、`mobile/src/utils/apiClient.js` 與本次同意流程測試
**觸發原因**：付款前同意證據與 LINE Pay request gate 屬金流／身份驗證相關改動，依專案規則完成聚焦安全複查
**方法**：讀取本次完整同意流程與其呼叫的付款 request、SQLite／PostgreSQL persistence、Mobile 送出路徑；檢查注入、身份／授權、金額竄改、規則內容竄改、機密與 provider 呼叫順序；另執行單元、SQLite 完整性、repository smoke、SQL safety 與 Mobile Babel 解析

### 發現與修正

| 嚴重度 | 位置 | 問題 | 修正 | 狀態 |
|--------|------|------|------|------|
| 中 | `mobile/src/screens/PaymentAuthorizationScreen.jsx` | 既有「模擬預授權成功」按鈕可以只改 Mobile local state，不經 Backend 保存同意證據，畫面會看似已授權 | 移除 pending 狀態的本機模擬授權入口；付款只能走 Backend LINE Pay request gate | 已修 |

修正後沒有發現其他達門檻的安全問題。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 身份與授權 | LINE Pay request 仍要求 bearer token，並改為只允許 `orders.customer_user_id === authUser.id`；管理員不能代顧客建立同意紀錄，測試已證明 403 且 provider 不會被呼叫 |
| 規則與時間竄改 | Client 只提交 `accepted`、`ruleType`、`ruleVersion`；Backend 驗證現行版本，保存自己的完整規則全文與真實伺服器 UTC 時間，不接受 Client 的全文、帳號或時間，也不使用 dev 模擬業務時間 |
| SQL 注入與跨訂單寫入 | SQLite 與 PostgreSQL 均使用參數化 SQL；`INSERT ... SELECT` 從訂單列取得真正的 `customer_user_id`，並以 order ID + owner 條件限制，沒有字串拼接或由 Client 指定證據歸屬 |
| Append-only／重試 | `(order_id, rule_type, rule_version)` 唯一鍵配合 conflict-ignore，重試會讀回第一筆紀錄，不覆寫同意時間或內容；服務還會比對讀回的 owner、版本與全文，不一致即停止付款 |
| Provider 呼叫順序 | 缺少同意、版本過期、保存失敗或 owner 不符都在 `requestLinePayPayment` 前終止；測試以注入的 provider 函式確認不會被呼叫 |
| 金額竄改 | 同意 gate 沒有改動金額來源；既有 `order.originalAmount === Number(body.amount)` 與 pending authorization repository 再驗證仍保留 |
| 機密與資料外洩 | 公開規則 API 只回傳規則類型、版本、標題與全文，不回傳訂單、帳號、Firebase UID、token 或 provider 機密；同意錯誤也不包含機密 |

**驗證限制**：`npm test` 48 項、`payment-authorization-request:smoke`、`check:sql-safety`、SQLite `integrity_check`／`foreign_key_check` 與 Mobile Babel 解析已通過；PostgreSQL `005` 只驗證 runner 排序與 repository SQL smoke，未對 live PostgreSQL 套用 migration；尚未執行 Android 長文排版與 LINE Pay sandbox 人工 E2E。ECPay UI 目前隱藏且未套用本次同意 gate，因此不列為已完成。

---

## 2026-08-15 — Provider 告警驗證與顧客最終結算快照顯示

**範圍**：`backend/payments/reliabilityService.js`、`backend/database/repositories/groupBuyActivityReadRepository.js`、`backend/db.js`、`mobile/src/navigation/AppNavigator.js`、`mobile/src/utils/groupBuyActivityProgress.js`、`mobile/src/screens/GroupProgressScreen.jsx` 與本次新增／更新的測試
**觸發原因**：可靠性告警屬付款維運範圍，最終結算畫面會呈現顧客實際應付金額，依專案規則完成聚焦安全複查
**方法**：讀取本次 diff 與活動結算、顧客訂單讀取及 Mobile 正規化路徑；檢查 SQL 注入、身份／授權、金額竄改、機密與公開資料、錯誤日誌內容；執行單元測試、PostgreSQL read repository smoke、SQL safety、SQLite 唯讀完整性檢查、Mobile Babel 解析與 Web export

### 發現

沒有發現安全問題。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 金額權威來源 | 顧客「實際應付」只讀取 Backend 訂單 `finalAmount`；Mobile 只計算原價與最終金額的顯示差額，不把任何顯示值回寫 Backend，也沒有改動 capture／void／refund 狀態轉移 |
| 最終狀態判斷 | Mobile 只有收到 Backend 已保存的 `settlement` 才顯示最終結果；單純由裝置判斷已截止不會自行宣告成團或最終折扣 |
| SQL 注入 | PostgreSQL settlement 讀取使用固定 SQL，沒有把 query、帳號、活動 ID 或其他外部輸入拼入 SQL；本次沒有新增資料庫寫入 |
| 身份與授權 | 沒有更動 Firebase、bearer token、角色解析、商家店家權限或付款 route；`GET /api/group-buy-activities` 維持原本公開讀取性質 |
| 公開資料與機密 | 新增的 `settlement` 只包含活動層級的杯數、折扣分配、尾差、版本與結算時間，不含顧客帳號、Firebase UID、付款交易編號、token 或 provider 金鑰；顧客訂單金額仍由既有受保護訂單 API 取得 |
| 告警內容 | 本次只把既有 `logAlertRequiredJobs` 列入可測介面並驗證篩選行為，沒有擴張日誌欄位；告警仍只輸出工作識別、狀態、次數與既有序列化錯誤，不輸出環境憑證 |
| 數值邊界 | Mobile 顯示 helper 只接受非負整數；缺少或不合法的訂單最終金額顯示為待同步，不用預設 0 偽裝成已結算金額 |

---

## 2026-08-22 — 新增管理員網頁後台（`/admin`）

**範圍**：`backend/server.js` 新增的 `/admin`、`/admin/login`、`/admin/logout`、`/admin/group-buy-activities/:id/cancel`、`/admin/refund-requests`、`/admin/refund-requests/:id/approve`、`/admin/refund-requests/:id/reject` 路由與相關 helper 函式（`getAdminWebUser`、`requireAdminWebUser`、`verifyAdminWebPassword`、`buildAdminCsrfToken`、`verifyAdminCsrfToken`、`buildAdminSessionCookie` 等）；`backend/auth.js` 的既有 `createAuthToken`／`verifyAuthToken` 未改動，只是被新入口重用。Mobile 端同時移除 `AdminDashboardScreen.jsx`、`AdminRefundRequestsScreen.jsx` 與相關 API client 函式，純刪除不影響本次安全範圍。
**觸發原因**：使用者要求把管理員功能從手機 App 移到獨立網頁後台；改動涉及退款核准（金流）與新的登入/session 機制，依規則主動觸發

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|------|------|
| 中 | `backend/server.js`（`buildAdminSessionCookie`／`buildAdminSessionClearCookie`） | 新的 admin session cookie 一開始沒有加 `Secure` 屬性；這個 cookie 帶的是跟既有 JSON admin API 共用的同一把簽章 token，若未來透過非 HTTPS 存取（例如內部 staging 網址、被 SSL-strip），有被網路中間人攔截並重放取得完整管理員權限的風險。信心度 7/10（在正式環境用 TLS 部署時風險才成立，本機開發本來就是明文 HTTP） | 加上 `Secure`，比照檔案裡既有的 `NODE_ENV === "production"` 條件式寫法，本機開發維持可用、正式環境自動加固 | 已修（當下就修，`adminCookieSecureAttribute()`） |

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| XSS | 新的 admin HTML 頁面裡，所有外部可控字串（活動標題、店名、取消原因、退款店家/訂單 ID/申請原因/駁回原因、從 query string 讀出的 flash 訊息、登入錯誤訊息、CSRF token 本身）都有經過既有 `escapeHtml()` 才插進 HTML；沒有插值的只有數字（杯數、人數）跟已經 `encodeURIComponent()` 處理過、用在雙引號屬性裡的 ID |
| CSRF | 所有會改資料的表單（取消團購、核准/駁回退款）都要求一次性 CSRF token，token 是 `HMAC-SHA256(sessionToken, AUTH_SESSION_SECRET)`，沒有 cookie 就算不出來；沒帶或帶錯 token 一律 403，已用真實 HTTP 請求驗證擋下 |
| 認證繞過 | `/admin/login` 用 `crypto.timingSafeEqual` 做固定時間密碼比對，沒有預設密碼／空密碼可以繞過的路徑；`ADMIN_WEB_PASSWORD` 沒設定時直接判定密碼錯誤，不會意外開放 |
| 授權 | 每個受保護路由都先呼叫 `requireAdminWebUser` guard，session 解出來的 user 一定要 `roles.includes("admin")` 才算數；沒有其他角色可以誤觸這些路由 |
| 業務邏輯是否被繞過 | 取消團購／核准退款／駁回退款都直接重用既有 `cancelMerchantGroupBuyActivity`／`approveRefundRequest`／`rejectRefundRequest`，完全沒有另外寫一套簡化版邏輯；連 Postgres/SQLite 執行模式一致性 boot-time 檢查（`isSqliteOrderDependentRoute`／`isSettlementRouteReadyForPostgres`）都特地把新路由納入同一個既有 gate，不會繞過 |
| SQL injection | 本次沒有新增或修改任何 SQL 查詢，新路由都是呼叫既有 repository／service 函式 |
| Session 固定攻擊 | 每次登入都重新 `createAuthToken`，沒有讓 client 指定或延用舊 token 的路徑 |

**驗證方式**：以真實 HTTP 請求（非模擬）驗證登入成功／密碼錯誤／未登入導向登入頁／CSRF 缺失回 403／CSRF 正確但目標不存在回傳正確錯誤訊息／登出清除 cookie；未對真實資料觸發一次成功的取消或退款核准（避免動到開發資料庫裡的真實資料）。`npm test` 69/69 全數通過（未改動任何被測邏輯）。

---

## 2026-08-22（同日追加）— 呼應上一筆：`/code-review` 發現的修復

**範圍**：對同一批 `/admin` 網頁後台程式碼做的後續修改，回應 `/code-review`（xhigh 強度，10 個角度）找到的 15 個問題裡跟這份安全記錄相關的幾項：把 `verifyAdminWebPassword`／`verifyAdminCsrfToken` 改成呼叫 `backend/auth.js` 新匯出的 `safeEqual()`（不再各自重複寫一份 timing-safe 比對）；把 `getAdminWebUser` 改成呼叫新的共用 `getUserFromToken()`（跟既有 `getAuthenticatedUser` 共用同一套 token 解析邏輯）；`POST /admin/login` 改成直接 `getById(ADMIN_WEB_USER_ID)` 查詢，不再呼叫只該給開發模式身份切換器用的 `listDevUsers()`；把三個會改資料的表單（取消團購、核准／駁回退款）的 CSRF 檢查抽成共用的 `readCsrfVerifiedAdminFormBody()`；把 `GET /admin/refund-requests` 補進原本漏掉的 PostgreSQL 執行模式一致性檢查（`isSqliteOrderDependentRoute`／`isSettlementRouteReadyForPostgres`）；這個檢查若觸發，`/admin/*` 路徑現在會回傳有樣式的 HTML 錯誤頁，不再是沒有樣式的原始 JSON。
**確認是否解決**：這批修改全部是重構（保留原本行為，只是把重複的邏輯抽成共用函式）或是「新增檢查/新增資訊揭露」（例如把原本悄悄吞掉的訂單取消失敗清單顯示出來），沒有任何一項是放寬權限、放寬驗證或縮小檢查範圍——已用真實 HTTP 請求重新驗證登入、CSRF 拒絕、cancel 對不存在活動回傳翻譯過的中文錯誤訊息（而非原始英文代碼）、refund reject 對不存在申請回傳正確錯誤訊息、登出流程都正常，`npm test` 70/70（含新增的跨午夜取餐時間標籤測試）全數通過。判定：上一筆記錄的所有發現都已解決，不需要另外開一輪完整安全審查。

**驗證限制**：`npm test` 53 項、`group-buy-activity-read:smoke`、`check:sql-safety`、SQLite `integrity_check`／`foreign_key_check`、Mobile Babel 解析與 Web export 已通過；沒有呼叫真實 LINE Pay／ECPay、沒有對 live PostgreSQL 執行 migration，也尚未由使用者在 Android 模擬器人工確認最終結算卡片排版。

---

## 2026-08-23 — 管理員網頁後台改為支援多組密碼

**範圍**：`backend/server.js` 的 `verifyAdminWebPassword`；`backend/.env` 的 `ADMIN_WEB_PASSWORD`（單一密碼）改名為 `ADMIN_WEB_PASSWORDS`（逗號分隔的多組密碼）
**觸發原因**：使用者要求把單一密碼換掉，並新增 3 組密碼供不同人使用（共 4 組）

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 比對方式 | 每組密碼都用既有的 `safeEqual()`（timing-safe）逐一比對，用 `reduce` 而非 `.some()`——即使某一組提早比對成功，後面的組別還是會照樣比對完，避免比對次數／時間差洩漏「submit 的密碼命中第幾組」這種側channel 資訊 |
| 密碼強度 | 4 組密碼都是使用者自訂、非本工具產生，強度判斷交由使用者自行負責；沒有把任何一組寫死在程式碼裡（只在 `backend/.env`，不進 git） |
| 身份模型 | 4 組密碼都對應同一個管理員身份（`user-admin-001`），沒有因為多組密碼而分裂出多個身份或多套權限，audit log 仍然是同一個 `actorUserId`，沒有新增稽核缺口 |
| 舊密碼失效 | 舊的單一密碼 `UGznhaQHBr0W` 已從設定檔移除，改用真實 HTTP 請求驗證確認舊密碼跟隨意亂猜的密碼一樣會被拒絕（`error=1`），4 組新密碼各自都能成功登入 |

**驗證方式**：以真實 HTTP 請求驗證 4 組新密碼皆可登入、舊密碼與亂猜密碼皆被拒絕。`npm test` 70/70 全數通過（未改動任何被測邏輯）。

---

## 2026-08-24 — 本機測試控制台併入 /admin 登入、個人中心新增真正的登出

**範圍**：`backend/server.js`（`/dev-console/*` route gate、`buildAdminSessionCookie`／`buildAdminSessionClearCookie` 的 cookie Path）；`mobile/src/navigation/AppNavigator.js`（新增 `navigation.logout()`）；新檔 `mobile/src/screens/ProfileScreen.jsx`；`mobile/src/screens/RoleSelectScreen.jsx`（登入後把完整 user 物件往下傳）
**觸發原因**：使用者要求「本機測試控制台是後台的一部分，進入要密碼」，把原本只靠 loopback 限制、不需要密碼的 `/dev-console` 併入 `/admin` 的登入狀態；順帶把個人中心的「登出」從假登出（只是換畫面）改成真的清掉登入憑證

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 中 | `mobile/src/navigation/AppNavigator.js`（新增的 `logout()`） | `logout()` 原本只清掉 token／角色／會員資料，沒清本機快取的 `orders`／`cartItems`／`paymentAuthorizations`；這些資料用一個只有 4 筆對照的固定表（`RoleSelectScreen.jsx` 的 `backendCustomerToPrototypeCustomer`）分桶，任何不在表裡的真實帳號都會落到同一個 fallback 桶（`"customer-yinji"`）。同一台裝置上，A 登出後 B 用不同真實帳號登入，會看到 A 留下的購物車與訂單/付款紀錄 | 在 `logout()` 裡一併清空 `orders`／`cartItems`／`paymentAuthorizations` 並重設 `selectedCustomerId`／`selectedMerchantStoreId` 為預設值 | 已修 |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| `/dev-console` 存取控制完整性 | 逐一核對 `/dev-console` 區塊裡的每一條 route（頁面、靜態檔、`api/status`、`api/accounts`、`api/business-time` GET/PUT、`api/config` GET/PUT、`api/config/reset`、`api/events`），全部落在新加的 `requireAdminWebUser` 檢查之後，沒有漏掉任何一條 |
| App 呼叫路徑沒被誤鎖 | Mobile App 本身直接呼叫的 `GET /dev-console/api/app/config`／`POST /dev-console/api/app/report`（`mobile/src/utils/devLocationControl.js`）刻意排除在新的密碼檢查之外，仍只靠原本的 loopback + `AUTH_DEV_MODE` 把關；用不帶任何 cookie 的 `curl` 實測仍回 200，人看的頁面／控制 API 在同樣條件下正確被導去登入頁 |
| Cookie Path 放寬（`/admin` → `/`） | `HttpOnly`／`SameSite=Lax`／正式環境的 `Secure` 屬性都沒變；確認 `parseCookies(request)[ADMIN_SESSION_COOKIE_NAME]` 只在 `/admin/*` 跟 `/dev-console/*` 這兩處被讀取，其他路由不會意外因為 cookie 送達範圍變大而多長出新的攻擊面 |
| 兩支例外路由本身的資料外洩風險 | `api/app/config`／`api/app/report` 讓同機任何呼叫者可讀寫別的測試帳號模擬定位，但這個能力併入前就已存在（僅限本機 + 開發模式），這次沒有擴大 |
| `ProfileScreen.jsx` 資料範圍 | 只顯示 `currentUserProfile` 這個 prop 本身帶的資料（登入當下後端已回傳、屬於目前登入者自己），沒有另外呼叫任何 API 或顯示其他角色/其他使用者的資料 |

**驗證方式**：以真實 HTTP 請求驗證：`/admin` 未登入導向登入頁、登入後 `/dev-console` 頁面與帳號列表可直接開啟（同一顆 session cookie）、`api/app/config` 全程不帶 cookie 仍回 200、`api/accounts` 不帶 cookie 回 302 導向登入頁。Web 預覽走過完整流程：登入 → 個人中心顯示真實資料 → 登出 → 回到登入畫面，且登出後本機快取的訂單／購物車／付款紀錄狀態確認已重設。

---

## 2026-08-24（同日追加）— 正式告警通知管道（ALERT_WEBHOOK_URL）

**範圍**：新檔 `backend/payments/alertNotifier.js`；呼叫端 `backend/payments/reliabilityService.js`（`logAlertRequiredJobs`、reconciliation scheduler 的頂層 catch）、`backend/payments/settlementService.js`（settlement scheduler 的 per-job alert 迴圈與頂層 catch）
**觸發原因**：呼應 `docs/AI-security-review-log.md` 之前一筆與 `PROGRESS.md` 都記錄過的「正式告警通知管道 [待處理]」——原本付款背景工作失敗只寫進伺服器本機的結構化 log，這次補上一個可設定的外部 webhook，讓失敗能主動推播出去

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 中 | `backend/payments/settlementService.js`（`runDueGroupBuySettlementJobs` 把整個 `result` 存成 job 的 `lastError`，含 `plan.orders`／`results`／`failures` 三個陣列） | 結算排程失敗時，`job.lastError` 帶的是**整個團購活動所有訂單**的明細（每筆訂單的 `customerUserId`、`providerTransactionId`、金額），跟 LINE Pay 對帳排程刻意精簡過的 `{message, linePayPayload}` 不一樣。這份完整明細被原封不動送進 `sendPaymentReliabilityJobAlert`，等於把一整批顧客與金流識別碼從「只存在伺服器本機」擴大到「送到操作員自己接的外部 webhook（Slack／Discord 之類）」，範圍比原本只寫本機 log 大很多 | 在 `alertNotifier.js` 送出前先摘要化：拿掉 `plan`／`results`／`failures` 這三個陣列本身，只保留筆數（`orderCount`／`resultCount`／`failureCount`），其餘欄位（`error` 代碼等）照舊送出 | 已修 |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 是否外洩密鑰／憑證 | 追過 `linePayClient.js`／`ecpayClient.js` 的錯誤物件組成，`lastError`／`linePayPayload` 只會帶 provider 回傳的代碼／訊息，從沒帶過 channel secret、HashKey/HashIV、bearer token 這類機密 |
| `ALERT_WEBHOOK_URL` 本身是否可被外部操控 | 純粹讀 `backend/.env`，跟使用者輸入無關；依既有審查慣例，環境變數視為受信任設定，不算攻擊面 |
| Webhook 呼叫是否會反過來影響金流邏輯 | `postAlertWebhook` 的回傳值只用在自己的 log／回傳結果，沒有被拿去判斷任何工作是否算完成、是否要重試——webhook 掛掉或回應異常不會讓真正的付款/結算判斷跟著錯 |
| 未設定時的行為 | `ALERT_WEBHOOK_URL` 沒設就完全不呼叫 `fetch`，`npm test`／sandbox 環境不會意外對外發送任何請求 |

**驗證方式**：新增 7 個單元測試（未設定時不呼叫、成功送出、webhook 回應非 2xx、webhook 連線失敗、排程層級失敗、以及這次修復的「settlement 明細被摘要化、顧客 ID／交易序號不再出現在送出內容裡」），與既有測試共 77/77 全數通過；重新啟動 backend 確認模組正常載入、排程照常啟動。

---

## 2026-08-26 — ECPay webhook 可被用來偽造「已付款」訂單，新增後端總開關

**範圍**：`backend/payments/ecpayService.js`（`handleEcpayReturnWebhook`，唯讀調查，本次未修改）、`backend/payments/ecpayClient.js`（`getEcpayConfig`／`verifyEcpayCheckMacValue`，唯讀調查，本次未修改）、`backend/server.js`（新增 `isEcpayEnabled()`，四支 ECPay 路由 `/api/payments/ecpay/request`／`checkout-redirect`／`return`／`client-back` 加上總開關擋門）、`.env.example`（新增 `ECPAY_ENABLED=false` 說明）
**觸發原因**：使用者直接提問「檢查是否能透過未完成的 ecpay 漏洞去動到訂單」，非 CLAUDE.md 規則自動觸發，屬於手動要求的調查
**呼應**：2026-08-20 那筆審查過 ECPay 的 Postgres 支援，範圍是「webhook 會不會被重放造成重複請款/授權」並確認沒問題；這次發現的是兩個不同的問題（見下），2026-08-20 的結論不受影響、也沒有被推翻，只是那次審查範圍沒有涵蓋到這兩點

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 高 | `backend/payments/ecpayService.js:209`（`handleEcpayReturnWebhook`） | 只驗證 `CheckMacValue` 簽章是否合法，從未檢查 ECPay 真正代表付款結果的 `RtnCode` 欄位，簽章一過就無條件呼叫 `authorizeAuthorization` 把訂單標記為已付款；往下追過 `backend/db.js`（`authorizeLinePayPaymentInDatabase`）與 Postgres 版 `confirmPostgresAuthorization` 兩條路徑，皆沒有任何地方檢查過 `RtnCode`。顧客只要在 ECPay 真實頁面上讓卡片刷卡失敗，ECPay 仍會送出一個「簽章正確、內容為失敗」的通知，系統會誤判為付款成功——不需要偽造任何東西，走真實 ECPay 流程即可觸發 | 在 `authorizeAuthorization` 之前，額外檢查 `formFields.RtnCode === "1"`，非成功一律回傳失敗、不得呼叫任何會改動訂單狀態的函式 | 待處理（本次先用下面的總開關擋住整條路徑，尚未修這個檢查本身） |
| 高 | `backend/payments/ecpayClient.js:17-30`（`getEcpayConfig`） | `ECPAY_ENV` 沒有明確設成 `"production"` 時預設為 `"stage"`，此時 `hashKey`／`hashIv` 會 fallback 成 ECPay 官方開發者文件公開發布的測試密鑰（`STAGE_HASH_KEY`／`STAGE_HASH_IV`），任何人都查得到、算得出合法的 `CheckMacValue`。已核對目前 `backend/.env` 實際設定確實是 `ECPAY_ENV=stage` 且未另外設定 `ECPAY_HASH_KEY`／`ECPAY_HASH_IV`，符合觸發條件；`ECPAY_RETURN_URL` 也設成一個公開的 Cloudflare tunnel 網址，代表這條路徑理論上可被公開存取。攻擊者需先合法擁有一筆自己訂單的待付款 ECPay 授權（`/request` 本身有做歸屬與金額檢查，無法幫別人的訂單建立），之後可完全跳過 ECPay 頁面，直接偽造簽章正確的 POST 打到 `/return`，讓自己的訂單被標記為已付款 | 正式環境要求 `ECPAY_ENV` 必須明確設定且不得預設 fallback 到 stage 金鑰；或至少在 `assertEcpayConfig` 加上「正式環境偵測到仍在使用已知的公開 stage 金鑰」時直接拒絕啟動 | 待處理（本次先用下面的總開關擋住整條路徑，尚未修這個 fallback 本身） |

### 已完成的緩解措施（本次實際改動）

上面兩個問題都還沒有直接修正核心邏輯，但確認：手機 App 隱藏 ECPay 付款入口（`PROGRESS.md`）**沒有**同步在後端擋掉這幾支路由，直接用 HTTP 呼叫完全打得到，等於「藏起來」目前沒有提供實際防護。考量 ECPay 業務上已經是「備援、暫緩」優先度，且要正確修好上面兩個問題還需要重新過一次完整的 ECPay 端對端測試，這次先加一個後端總開關：新增 `isEcpayEnabled()`（讀取 `ECPAY_ENABLED`，預設 `false`），四支路由（`request`／`checkout-redirect`／`return`／`client-back`）在最前面就擋下，未經明確設定 `ECPAY_ENABLED=true` 一律回傳「暫停使用」，不會呼叫任何會讀寫訂單的邏輯。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 金額能否被偽造 | `handleEcpayReturnWebhook` 用的是資料庫裡既有 `pendingAuthorization.originalAmount`，不是採信偽造請求裡的金額欄位，所以上面的漏洞只能讓「已存在、金額正確」的待付款授權變成已付款，無法無中生有偽造任意金額的訂單 |
| 新開關本身是否引入新的注入或資料外洩 | `isEcpayEnabled()` 只讀取受信任的環境變數；四處新增的 503 回應重用既有 `buildLinePayResultPage`／`buildLinePayAppReturnUrl`／`toSafeScriptString`，跟原本程式碼路徑用的是同一套跳脫邏輯，`orderId` 沒有新的資料流向 |
| 新開關是否弱化任何既有檢查 | 四個新增的 `if (!isEcpayEnabled())` 都是最先執行、且只會讓路由回應「停用」提早結束，不會略過或改動後面任何既有的驗證邏輯 |

**驗證限制**：本次是唯讀調查加上一個純粹「提早擋門」的開關，沒有實際呼叫真實 ECPay 網路，也沒有重建/寫入開發資料庫；`npm test` 84/84 全過、`node --check backend/server.js` 語法檢查通過。尚未用真實 HTTP 請求驗證停用後四支路由的實際回應內容（需要重啟目前正在跑的本機 backend process 才能載入新程式碼，這次沒有主動重啟使用者手動啟動的 dev server）。`RtnCode` 檢查與 stage 金鑰 fallback 這兩個核心問題本身仍待修——若之後要重新啟用 ECPay，這兩點必須先修好才能把 `ECPAY_ENABLED` 打開。

## 2026-08-27 — 呼應上一筆：ECPay 整個移除，而非修復

**範圍**：`backend/server.js`（移除 4 支路由、repository 初始化與所有 postgres 就緒檢查）、`backend/payments/ecpayService.js`／`ecpayClient.js`（整檔刪除）、`backend/database/repositories/ecpayAuthorizationRepository.js`（整檔刪除）、`backend/payments/settlementService.js`／`merchantActivityCancelService.js`／`refundRequestService.js`（移除 ECPay 分支，保留 LINE Pay 邏輯）、`backend/db.js`（刪除一次性 `widenPaymentProviderCheckConstraints` 遷移函式）、`database/schema.sql`（`payment_authorizations`／`payment_refunds` 的 `provider` CHECK constraint 收回只允許 `line_pay`／`mock_line_pay`）、`mobile/src/screens/PaymentAuthorizationScreen.jsx`／`mobile/src/utils/apiClient.js`（移除信用卡付款選項與對應 API 呼叫）、`scripts/ecpay-smoke.js`／`ecpay-authorization-repository-smoke.js`（整檔刪除）、`.env.example`／`backend/.env`／`package.json`（清除對應設定與 script）
**觸發原因**：使用者確認後，直接要求「把 ecpay 完全刪除以絕後患」，取代上一筆記錄裡「先加總開關」的暫時緩解措施
**呼應**：直接呼應上一筆（2026-08-26）記錄的兩個高風險發現——`handleEcpayReturnWebhook` 缺少 `RtnCode` 檢查、`getEcpayConfig` 在非正式環境 fallback 成公開 stage 金鑰。兩者當時都標記「待處理」，這次確認：**兩者已完全解決**，因為存在這兩個問題的程式碼（`ecpayService.js`、`ecpayClient.js`）已整檔刪除，不是繼續留著加強防護，是問題所在的程式碼本身不存在了

### 發現

沒有找到信心度達到門檻（8/10 以上）的新漏洞。這次改動性質是移除既有攻擊面，不是新增邏輯。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 是否有殘留但仍可觸發的 ECPay 程式碼路徑 | `grep -ri ecpay` 掃過整個 repo（不含歷史紀錄型文件與已套用的 migration 檔），backend／mobile／scripts 三個目錄下已無任何殘留引用；語法檢查（`node --check`）全數通過 |
| 移除 provider 分支後，LINE Pay 既有邏輯是否被連帶改動 | `settlementService.js`／`merchantActivityCancelService.js`／`refundRequestService.js` 三處都是刪除 `isEcpayProvider(...)` 判斷式整個分支，LINE Pay 那條分支的程式碼本身逐行核對未被觸碰；`npm test` 84/84 全過 |
| 移除的路由是否留下可被利用的殘破狀態 | 4 支路由（`request`／`checkout-redirect`／`return`／`client-back`）連同 `isEcpayEnabled()` 開關一起整段刪除，不是只刪路由留著開關，也不是只關開關留著路由；實際啟動 backend（對真實 PostgreSQL）後人工測試 `POST /api/payments/ecpay/request` 與 `GET /api/payments/ecpay/client-back`，回應是既有「`/api/payments/` 前綴但找不到對應路由」的通用 503（`customer_order_runtime_mismatch`），跟其他任何不存在的 `/api/payments/*` 路徑行為一致，不是殘留的 ECPay 專屬回應 |
| CHECK constraint 收窄是否影響既有資料 | 只改了 `database/schema.sql`（給全新建立的資料庫用的範本）與 `backend/db.js` 裡同樣只在資料表不存在時才會執行的 `CREATE TABLE IF NOT EXISTS`；沒有對正在使用中的 SQLite 開發檔案或真實 PostgreSQL 資料庫執行任何 `ALTER`／`migrate`，兩邊的既有資料表結構未被觸碰 |
| 移除後是否還有資料因此變成「處理邏輯消失」的孤兒 | 唯讀查詢過 SQLite 開發檔案與真實 PostgreSQL 資料庫的 `payment_authorizations`，`provider LIKE '%ecpay%'` 兩邊都是 0 筆，代表這次移除的分支在移除當下沒有任何真實資料依賴它 |
| Mobile 端移除是否留下死碼或壞掉的畫面邏輯 | `PaymentAuthorizationScreen.jsx` 的 `selectedProvider` state、付款方式選擇區塊、`getProviderDisplayName` 與所有 `=== "ecpay"` 分支已一併移除並簡化成單一 LINE Pay 路徑；`grep -ri ecpay` 整個 `mobile/` 目錄下已無殘留 |

**驗證限制**：`npm test` 84/84（不需要即時 PostgreSQL 連線的單元測試）全過；額外實際啟動 backend 對接真實 PostgreSQL 16，確認一般路由（`GET /api/stores`）正常回應、ECPay 路由回應變成通用 404-等效的 503（非 ECPay 專屬訊息），驗證後已關閉這個臨時啟動的測試 process，未影響使用者原本的 dev session。Mobile 端因為是 JSX，這次只做語法層面與逐行核對，沒有實際在模擬器／瀏覽器操作畫面確認付款流程——之後如果要對付款流程做一次真機或 Web 預覽的人工操作驗證，建議連同這次改動一起走一遍「送出訂單 → 進入付款畫面 → 完成 LINE Pay 授權」的完整路徑。

## 2026-08-28 — 管理員無條件取消團購 + 後台團購列表分歷史／進行中

**範圍**：`backend/payments/merchantActivityCancelService.js`（新增 `input.unconditional` 參數，繞過「僅限 recruiting 狀態」與「截止前 30 分鐘鎖定」兩道守門條件）、`backend/server.js`（兩個既有管理員取消路由——`DELETE /api/admin/group-buy-activities/:id` 與 `POST /admin/group-buy-activities/:id/cancel`——改傳 `unconditional: true`；`renderAdminDashboardBody` 重構為「進行中團購」／「歷史團購」兩個區塊；同時補上前一輪 `/code-review` 發現的 `/admin/refund-requests` 維護頁面缺少登入檢查的漏洞修復）、`scripts/merchant-activity-cancel-service-smoke.js`（新增兩個情境：管理員無條件取消繞過狀態與截止鎖定、非管理員呼叫仍維持原本限制）
**觸發原因**：使用者回報實機操作卡住——後台想取消一個 `ordering`／`failed` 狀態的團購被擋下「這個團購目前的狀態無法取消」；使用者要求管理員可無條件取消，並「決定是否退款」

### 設計決策（用 AskUserQuestion 跟使用者確認過，不是我自行假設）

已請款（`payment_status = captured`）的訂單，這次**完全不動**——不取消訂單、不觸發退款。使用者明確表示「退款應該要另外設一個管理金錢的地方不能跟其他綁再一起」，所以退款維持走既有的 `refundRequestService.js`（商家申請、管理員核准）這條獨立流程，不併入取消團購的邏輯。技術上這剛好也是既有 `listEligibleOrders` 查詢原本就有的行為（`payment_status NOT IN ('captured', 'refunded')` 早就排除已請款訂單），所以這次不需要改查詢，只需要確保「繞過狀態檢查」不會意外把這個既有的排除條件也繞過去。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| `unconditional` 旁路是否可能被非管理員觸發 | 全 repo 搜過 `cancelMerchantGroupBuyActivity(` 的三個呼叫點：商家自助取消（line 888）未傳這個參數、沿用原本的 `canManageStore` 真實檢查，不受影響；兩個管理員路由分別掛在 `authUser.roles.includes("admin")`（JSON API）與 `requireAdminWebUser`（web 表單，未登入會被導去 `/admin/login`）後面，兩道守門都是既有邏輯，這次沒有改動 |
| 繞過狀態檢查是否連帶繞過活動不存在／店家歸屬檢查 | `activity_not_found` 與 `canManageStore(activity.store_id)` 兩個檢查在 `input.unconditional` 判斷之前就先執行、不受這個旗標影響（管理員路由的 `canManageStore` 本來就固定回傳 `true`，是既有設計，不是這次新增） |
| 已請款訂單是否會被這次改動意外波及 | 用 smoke test 實際跑過一個「`ordering` 狀態＋1 筆待處理訂單＋1 筆已請款訂單」的情境，管理員無條件取消後確認：待處理訂單被取消，已請款訂單的 `status`／`payment_status` 完全沒被改動；另外用瀏覽器對真實 PostgreSQL dev 環境實際操作驗證了一次（見下方「驗證限制」），結果一致 |
| 管理後台列表重構（HTML 拆成兩區塊）是否有新的 XSS/跳脫遺漏 | 逐一比對重構前後：`activity.title`／`activity.status`／店名／取消原因／`csrfToken` 全部維持原本的 `escapeHtml(...)`，新增的兩個區塊標題只插入數字（陣列長度），沒有插入任何使用者可控字串 |
| 是否意外弱化商家自助取消原本的保護 | smoke test 新增情境 7 明確驗證：同樣的非 recruiting 狀態，商家自助取消（不傳 `unconditional`）仍然照舊被 `activity_not_cancellable` 擋下 |

**驗證限制**：`npm test` 92/92 全過；`merchant-activity-cancel-service:smoke`（會重建本機 SQLite dev 資料庫）經使用者明確同意後執行，執行前已備份、執行後確認 `integrity_check=ok` 且 0 筆 foreign key 違反。另外用瀏覽器實際登入 `/admin` 對**真實 PostgreSQL dev 資料庫**操作驗證了取消 `ordering`／`failed` 狀態團購兩種情境，過程中不慎誤解了這個專案的實際 runtime（以為團購讀寫走 SQLite，其實永久走 PostgreSQL），導致兩筆真實種子測試資料被意外取消；已在使用者確認後用一次性、範圍精確的 SQL 修正腳本把這兩筆活動的 `status`／`cancellation_reason`／`updated_at` 還原，並刪除因此多出的 `status_history`／`audit_logs` 紀錄，還原後重新讀取確認資料與異動前一致。

## 2026-08-29 — 顧客放棄 LINE Pay 付款後卡死無法重試

**範圍**：`backend/payments/linePayService.js`（`requestLinePayAuthorizationUnlocked` 的既有授權檢查邏輯）、`backend/payments/orderRuleConsent.test.js`（新增一個自動化測試情境）、`backend/server.js`（把既有的 `paymentAuthorizationCancelRepository` 多傳一個進去）、以及幾個純 UI 改動（`mobile/src/components/ActivityFilterPanel.jsx`、`mobile/src/navigation/AppNavigator.js`、`mobile/src/screens/CustomerOrdersScreen.jsx`、`LiveMapScreen.native.jsx`／`.web.jsx`、`MerchantMenuManagementScreen.jsx`、`PaymentAuthorizationScreen.jsx`）
**觸發原因**：使用者實機操作回報——顧客點「付款」跳轉到 LINE Pay 後，如果沒完成就退出 App，之後再點「付款」會被永久擋下「已有一筆進行中」，訂單卡死。這是金流相關改動，依 CLAUDE.md 規則主動跑這次審查

### 設計決策（跟使用者來回討論多輪、逐步驗證後才定案，不是我單方面假設）

問題根因：LINE Pay 對「還沒確認的付款請求」沒有提供「主動取消」的 API（只有已確認的授權才能撤銷），系統只能等 LINE Pay 自己判定過期，但 LINE Pay 官方文件沒有公開這個等待時間有多長（實際上網查證過官方文件，確認查無此資訊）。討論過三種「自訂等待上限」的做法（純即時查詢不設上限、自訂等待幾分鐘、立刻放棄），使用者最後決定：**放棄舊的、立刻讓顧客重新開一筆**，不特別設等待時間，理由是參考了另一個真實上線 App 的行為（退出付款頁面就直接視為放棄）。

實作前先確認了一個關鍵安全網：即使顧客後來真的跑回去把舊的 LINE Pay 頁面完成，本檔案 `confirmLinePayAuthorizationUnlocked` 裡本來就有一道既有守門（`authorization_not_pending` 檢查），會在呼叫 LINE Pay 正式確認 API **之前**先確認本地紀錄還是不是 `pending`；一旦我們已經把舊的標記失敗，這道守門會直接擋下，系統**不會**真的去跟 LINE Pay 說「請正式扣住這筆錢」，所以不會有真的授權成功卻沒人知道的情況。改動重用背景對帳排程本來就在用、已經測試過的同一個「標記放棄」函式，改單（order revision）情境也走同一套邏輯。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| 會不會有人取消別人的付款請求 | 訂單歸屬檢查（`order.customerUserId !== authUser.id`）在新邏輯之前就先執行；改單情境下 `order.id` 是從已驗證過的 `revision.orderId` 來的，不是直接信任前端傳來的值；傳給取消函式的交易 ID 也是從資料庫讀回來的既有紀錄，不是使用者自己填的 |
| 顧客手速很快連點兩次「付款」會不會同時生出兩筆 | 這個函式本來就被「同一筆訂單一次只能處理一個付款動作」的鎖包住，這次沒有改動這道鎖，也沒有繞過它 |
| 標記舊的失敗會不會不小心點錯、影響到明明還有效的付款 | 狀態判斷條件跟欄位存取都逐行核對過，沒有邏輯錯誤；重用的資料庫函式本身在真正寫入前還會在交易鎖裡再檢查一次目前狀態，就算被重複呼叫也不會出錯或留下重複紀錄 |
| 菜單管理畫面重構（自由文字改成逐項輸入）的加價欄位是否還是安全的數字 | 逐項輸入的「加價」欄位套用跟既有「基本價格」欄位一樣的逐字元過濾（只允許數字），從輸入當下就不可能打進非數字字元，不是靠事後解析失敗才擋下 |
| 其他改動（篩選面板、地圖畫面、返回鍵）是否引入新的注入或資料外洩 | 都是純畫面邏輯調整，沒有新增對外部資料的存取路徑，沒有把使用者輸入直接組進畫面或查詢 |

**驗證限制**：新增了一個自動化測試直接驗證「先放棄舊的、才建立新的」這個順序沒有反過來；另外重跑了負責「確認付款」與「取消付款」這兩塊的既有 smoke test（純記憶體模擬、沒有真實資料庫），確認我依賴的那道安全防線沒有被連帶改壞；`npm test` 93/93 全過。這個改動的核心價值（顧客真的能重新拿到一個可以完成付款的新頁面）需要實際走一次 LINE Pay 沙盒環境才能徹底驗證，這部分還沒有透過真機操作確認，記錄在待辦裡。

---

## 2026-08-29（同日追加）— 未付款訂單卡在進行中 + 截止後仍可發起新付款

**範圍**：`backend/payments/linePayService.js`（`requestLinePayAuthorizationUnlocked` 新增截止時間檢查）、`backend/database/repositories/groupBuySettlementRepository.js`（`createPostgresSettlementPlan` 新增「未付款訂單」結算清理）、`backend/db.js`（SQLite 對應的 `createGroupBuySettlementPlan`）、`backend/database/repositories/paymentAuthorizationRequestRepository.js`、`backend/database/repositories/orderRevisionRepository.js`（兩者的付款情境查詢補上 `deadlineAt`）、`backend/server.js`（呼叫端多傳 `now`）、`backend/payments/orderRuleConsent.test.js`（新增 2 個測試）、`scripts/group-buy-settlement-repository-smoke.js`（新增 1 個測試情境）、`mobile/src/screens/PaymentAuthorizationScreen.jsx`（新增錯誤訊息對應）
**觸發原因**：使用者實機操作回報——有一筆從未點過付款的訂單，對應團購早就截止卻沒有出現在歷史訂單。這是金流相關改動，依 CLAUDE.md 規則主動跑這次審查

### 背景（呼應上一筆 2026-08-29「顧客放棄 LINE Pay 付款後卡死無法重試」）

追查使用者回報的問題時，發現兩個獨立但都跟「團購截止時間」有關的缺口，與上一筆記錄的改動屬於同一批還沒 commit 的付款相關修改，但是不同的根因：

1. **`requestLinePayAuthorizationUnlocked` 完全沒有檢查團購截止時間**——理論上截止後（甚至已經結算完）仍能發起全新的 LINE Pay 付款請求。修法：讀取訂單所屬活動的 `deadlineAt`，跟呼叫端傳入的 `now`（統一用 `businessClock.nowIso()`，跟其他截止時間檢查同一個時鐘來源）比較，一旦逾期就回傳 409 `activity_deadline_passed`，不呼叫 LINE Pay provider。
2. **`getOrderLifecycleBucket`（判斷訂單該歸「進行中」還是「歷史」）沒有處理「從未發起過付款」的訂單**——這類訂單的 `paymentStatus` 永遠停在 `pending`，不會被既有的 `failed` 分支（15 分鐘取餐緩衝）或結算流程碰到，等於永遠卡在「進行中」。修法：截止結算時新增一步，把這類訂單標記為已取消（`status`／`pickup_status`／`merchant_acceptance_status` 皆設為 `cancelled`），比照既有商家/顧客取消訂單的欄位組合，付款狀態維持 `pending` 不動——這個決定是照抄 `merchantGroupBuyActivityCancelRepository.js`／`customerOrderCancelRepository.js` 既有的取消欄位組合，不是我新發明的狀態語意。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

### 沒發現問題的部分（已交叉驗證，方法：讀完整 diff＋追過呼叫路徑，不只看 diff 片段）

| 面向 | 檢查結果 |
|------|----------|
| 截止時間比對邏輯會不會因為資料缺失而悄悄失效、變成漏洞 | `Date.parse` 對缺失/格式錯誤的 `deadlineAt`／`now` 會直接跳過檢查（fail open）；但追過 `database/schema.sql`，`group_buy_activities.deadline_at` 是 `NOT NULL`，且訂單一定透過 `activity_id` 外鍵關聯到活動，兩個 repository 都改成 `JOIN`（不是 `LEFT JOIN`）取得活動列，實務上不會出現訂單有效但 `deadlineAt` 缺失的情況；`now` 只有伺服器端 `businessClock.nowIso()` 一個來源，不是使用者可控輸入 |
| 新訂單與改單（order revision）兩條路徑是否都套用了截止檢查，會不會有一條漏掉變成繞過 | 兩條路徑最後都會進到同一個 `requestLinePayAuthorizationUnlocked`；`orderRevisionRepository.js` 的 `getPostgresOrderRevisionPaymentContext` 跟訂單路徑一樣補上了 `deadlineAt`，兩邊處理方式一致，沒有漏掉 |
| 結算時把「未付款訂單」標記取消的 UPDATE 會不會不小心波及已經有效付款的訂單 | 這個 UPDATE 用 `activity_id + status = 'submitted' + payment_status = 'pending'` 限定範圍，跟旁邊既有「鎖定已授權訂單」那條 UPDATE 用的 `payment_status = 'authorized'` 互斥，兩者不會重疊；也追查過一個看似可能的競態（顧客在截止前一刻打開 LINE Pay，付款狀態還沒變成 authorized，結算掃描就先跑並把訂單取消掉）——但既有的 `confirmLinePayAuthorizationUnlocked`／SQLite 對應邏輯本來就會在 confirm 當下重新比對截止時間，逾期一律視為逾時失敗，不論訂單當下的 `status` 欄位是什麼，所以這個競態不會讓顧客「假裝沒付款但其實扣到錢」，取消是正確的終態，不是繞過收費的破口 |
| 新的 `GET /api/auth/session`（上一批改動就存在，這次沒有再改動，但因為同批一起審查所以一併確認）是否會讓人查到別人的 session | 沿用既有 `getAuthenticatedUser`（同一套 bearer token 驗證），失敗回 401，成功只回傳呼叫者自己的 `toPublicUserResponse`，跟登入路由回傳的形狀完全一致，沒有額外欄位、沒有跨使用者查詢 |
| `expo-secure-store` 的登入狀態還原會不會信任本機快取的角色/權限而繞過伺服器驗證 | 追過 `AppNavigator.js`：還原流程呼叫 `verifyAuthSession()`，用**伺服器回傳的最新 user 物件**（不是本機快取的 `session.user`）決定要導去哪個畫面；401 會清掉本機憑證，其他錯誤（例如離線）會保留憑證但停在載入畫面、不會直接放行進入任何已登入畫面 |

**驗證限制**：新增 2 個 `linePayService` 自動化測試（截止前成功／截止後拒絕）與 1 個 `group-buy-settlement-repository-smoke` 測試情境（驗證未付款訂單計數正確回傳），皆為記憶體模擬、非真實資料庫；`npm test` 95/95 全過。**尚未實機驗證**：需要真的讓一個團購走到截止、底下有一筆從未付款的訂單，確認結算後它正確被標記取消並移入歷史訂單分頁；也還沒有真的在截止後嘗試發起 LINE Pay 付款、確認前端正確顯示「這個團購已經截止，無法再付款。」。

---

## 2026-09-10 — 商家自助申請＋管理員審核（新功能）

**範圍**：新功能，完全不碰金流／LINE Pay 程式碼。`database/migrations/007_merchant_applications_postgres.sql`（新）、`backend/database/repositories/merchantApplicationRepository.js`（新）、`backend/merchants/merchantApplicationService.js`（新）、`mobile/src/screens/MerchantApplyScreen.jsx`（新），以及 `backend/server.js`（新增 `POST /api/merchant-applications`、`/admin/merchant-applications` 三支路由與對應 HTML 渲染）、`mobile/src/utils/apiClient.js`、`mobile/src/screens/RoleSelectScreen.jsx`、`mobile/src/navigation/AppNavigator.js` 的相關新增段落。
**觸發原因**：CLAUDE.md 規則自動觸發——這次改動雖然不是金流，但新增了「執行期間第一次會建立 `users` 資料列」這個 auth 相關的新路徑，比照高風險規則主動跑一次複查。
**方法**：獨立 subagent 讀完 4 個新檔案全文＋`server.js`／`apiClient.js`／`RoleSelectScreen.jsx`／`AppNavigator.js` 的新增段落＋`backend/firebaseAuth.js` 全文，追過從公開申請端點到核准交易的完整呼叫路徑，比對既有 `refund_requests` 審核模式的授權/CSRF/交易鎖定慣例。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| SQL injection | `merchantApplicationRepository.js` 所有查詢（含新增的 `create`／`approve`／`reject`／`list`／audit）都用 `$1...$n` 參數化，包含管理員填寫的緯度／經度／駁回原因，沒有字串拼接 SQL |
| 身份能不能被偽造，用別人的 Google 帳號送出申請 | `applicantFirebaseUid`／`applicantEmail`／`applicantDisplayName` 只取自 `verifyFirebaseIdToken`（真的呼叫 Firebase Admin SDK 驗證簽章/audience/expiry）解出來的 claims，從來不讀 request body；這條路徑沒有 `AUTH_DEV_MODE` 或任何後門繞過 |
| 核准／駁回能不能被非管理員呼叫 | 三支 `/admin/merchant-applications*` 路由都先過既有的 `requireAdminWebUser`（cookie session）＋ CSRF 驗證，service 層又重複檢查一次 `authUser.roles.includes("admin")` |
| 有沒有辦法讓申請流程拿到 admin 角色、或接到別人已經在用的商家／門市 | 核准交易一律用申請本身的 `store_name`／`address`／`contact_phone` 建新的 `merchants`／`stores`，`user_roles` 寫死 `role = 'merchant'`，整條路徑沒有任何欄位可以讓申請人或管理員指定角色或接到既有店家 |
| 資料外洩／XSS | 送出申請的回應與「已有待審申請」的 409 錯誤都只回傳申請人自己的資料；後台清單／卡片渲染申請人填寫的所有欄位（店名、地址、電話、Email、顯示名稱、駁回原因）都有經過既有 `escapeHtml` |
| 核准交易中途失敗（例如申請人其實已經是別間店的商家）會不會留下孤兒 `merchants`／`stores` 資料 | `FOR UPDATE` 鎖列＋`WHERE status='pending'` 擋掉重複核准；`merchant_users.user_id` UNIQUE 撞到時，整個 Postgres transaction 因為那個失敗的 INSERT 進入 aborted 狀態，外層 `transaction()` 直接變成 rollback，同一次嘗試裡已經送出的 `merchants`／`stores` INSERT 不會被 commit——已經用真實 Postgres 實際觸發這個情境驗證過（見下方驗證紀錄），確認沒有孤兒資料 |

### 驗證紀錄（真實執行，非記憶體模擬）

對本機真實 PostgreSQL 執行 `merchantApplicationRepository` 全部四個函式（不透過 HTTP，因為沒有真實 Firebase ID token 可用）：申請成功、同一 Firebase UID 重複送出待審申請被 partial unique index 正確擋下、核准後 `users`／`merchants`／`stores`／`merchant_users`／`user_roles`／`audit_logs` 皆正確各自新增一筆、重複核准正確 no-op、駁回路徑正確、已是商家的帳號再次核准正確觸發 `applicant_already_merchant` 且整個 transaction 正確 rollback（查證沒有孤兒 `merchants` 資料列）。另外透過瀏覽器實際登入 `/admin` 後台，完整跑過 `/admin/merchant-applications` 頁面渲染與核准表單的真實 HTTP 送出，並個別驗證兩個既有防護機制在新路由上仍然有效：沒有 session 存取回 302 到登入頁、有 session 但 CSRF token 錯誤回 403。過程中發現並修正一個真實 bug（不是安全漏洞，是 UX 問題）：`merchantApplicationService.js` 的錯誤物件屬性展開順序寫反，導致給管理員看的錯誤訊息被原始錯誤代碼蓋掉，已修正並重新驗證。測試資料驗證後已從資料庫清除。`npm test` 99/99 全過（未受影響）。

**驗證限制**：完全沒辦法在這個環境模擬真實 Google 帳號登入，所以「申請人真的用手機 App 走完 Google 登入 → 填表 → 送出」這條路徑本身，以及核准後「這個 Google 帳號真的能重新登入看到自己的商家後台」這一步，都只驗證到「後端邏輯層」，沒有做到真正的手機端對端測試。

---

## 2026-09-11 — Firebase 首次登入自動註冊為顧客 ＋ 商家核准角色轉換

**範圍**：`backend/database/repositories/customerRegistrationRepository.js`（新）、`backend/server.js`（`/api/auth/firebase-session` 的未對應 UID 分支，改成呼叫新 repository 而非直接回 403；新增 `deriveDisplayNameFromFirebaseUser` helper）、`backend/database/repositories/merchantApplicationRepository.js`（`approveApplicationPostgres` 新增「核准商家時，若這個帳號已有啟用中的顧客角色，一併停用」的角色轉換邏輯）、`mobile/src/screens/RoleSelectScreen.jsx`（按鈕文案、錯誤訊息對應）。
**觸發原因**：AGENTS.md 規則自動觸發——這是這個專案第一個「一般使用者自己登入就會被寫進 `users` 資料表」的路徑（先前所有帳號都是一次性 SQL seed，商家申請雖然也會寫入但需要走管理員審核）；同時延伸並修改了 2026-09-10 那筆已審查過的商家審核交易邏輯，呼應該筆記錄，一併確認角色轉換有沒有引入新問題。
**方法**：讀完新檔案全文＋`server.js`／`merchantApplicationRepository.js` 修改段落；追過從 Firebase token 驗證到寫入 `users`／`user_roles` 的完整交易路徑；針對「身份能否被偽造」「併發首次登入」「Email／UID 衝突」「停用帳號」「顧客轉商家角色轉換」逐一用真實本機 PostgreSQL 執行驗證（見下方）。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 身份能不能被偽造 | `firebaseUid`／`email`／`displayName` 只取自 `verifyFirebaseIdToken()`（真的驗證 Firebase 簽章／audience／expiry）解出來的 claims，從來不讀 request body；`deriveDisplayNameFromFirebaseUser` 的 fallback（email 前綴或「Google 使用者」）也只用驗證過 token 裡的欄位，沒有外部輸入 |
| 能不能自己拿到 merchant／admin | 新帳號一律寫死 `role='customer'`，沒有任何欄位讓 client 指定角色；核准商家時的角色轉換邏輯只在既有 `approveApplicationPostgres`（本身已受 `requireAdminWebUser`＋CSRF＋service 層 `roles.includes("admin")` 三重保護）內觸發，client 端無法直接觸發角色轉換 |
| SQL injection | 新 repository 全部查詢用 `$1...$n` 參數化；新增的 `UPDATE user_roles SET status='disabled' WHERE user_id=$1 AND role='customer' AND status='active'` 同樣參數化，沒有字串拼接 |
| 併發首次登入 | 靠 `users.firebase_uid` 既有 UNIQUE 約束擋，不是另外自己實作鎖；兩個同時的首次登入其中一個會撞 `23505`（constraint 名稱已對真實資料庫查證為 `users_firebase_uid_key`），撞到的那個會回頭讀出贏家的 userId，不會建出兩筆帳號 |
| Email 衝突時是否會誤連結或覆蓋既有帳號 | 不同 Firebase UID 但 email 撞到既有帳號（`users_email_key` 23505）一律回傳 `email_already_registered` 並且不建立任何新資料列，不嘗試自動連結、也不覆蓋既有那筆 |
| disabled／deleted 帳號是否會被重新啟用 | 查找已對應的 `firebase_uid` 時刻意不加 `status='active'` 條件（跟既有 `authProfileReadRepository` 的查詢刻意不同），抓到非 active 帳號一律回傳 `account_disabled`，不會被自動改回 active、也不會另外建一筆新帳號 |
| 顧客轉商家的角色轉換會不會被濫用 | 轉換只發生在既有、已受保護的 `approveApplicationPostgres` 交易內部，不是另開一個獨立可被呼叫的端點；只把 `customer` 角色的 `status` 改成 disabled，不刪除 `user_roles` 資料列本身，也不動 `users` 資料列，訂單／稽核歷史不受影響 |
| 資料外洩 | 兩個新的錯誤回應（`account_disabled`／`email_already_registered`）都不包含其他帳號的任何欄位（email、user id、display name 都不回傳），只回傳固定的英文錯誤訊息 |

### 驗證紀錄（真實執行，非記憶體模擬）

對本機真實 PostgreSQL 直接執行 `customerRegistrationRepository`（不透過 HTTP，因為沒有真實 Firebase ID token 可用）：全新 UID 正確建立 `users`＋`user_roles(customer)` 兩筆資料；同一 UID 重複呼叫正確回傳同一個 userId、沒有建出重複資料列；模擬兩個同時的首次登入（平行呼叫）正確收斂成同一個 userId、資料庫只留一筆；不同 UID 但同 email 正確回傳 `email_already_registered` 且沒有建立新資料列；把一筆帳號標記 `disabled` 後重新呼叫正確回傳 `account_disabled`。另外完整跑過「顧客自動註冊 → 用同一個 Firebase UID 送出商家申請 → 管理員核准」全流程，核准後直接查資料庫確認：這個帳號的 `customer` 角色被停用（`status='disabled'`）、`merchant` 角色啟用，並透過真正的 `authProfileReadRepository.getByFirebaseUid()`（`/api/auth/firebase-session` 實際會呼叫的同一支函式）確認回傳的角色只剩 `["merchant"]`，不會兩個角色並存。測試資料驗證後已從資料庫清除（先刪 `audit_logs`／`merchant_applications`，再刪 `stores`／`merchants`，最後刪 `users`，確認零殘留）。`npm test` 99/99 全過，`check:sql-safety` 通過。

**驗證限制**：跟 2026-09-10 那筆一樣，這個環境完全沒辦法模擬真實 Google 帳號登入，所以「使用者真的用手機 App 走完 Google 登入 → 後端自動建立顧客帳號 → 正常使用」這條路徑，只驗證到後端邏輯層與資料庫交易本身，沒有做到真正的手機端對端測試；`/api/auth/firebase-session` 這支路由本身的 HTTP 層（包含 `verifyFirebaseIdToken` 真的解析一個有效 token 之後接上這次新增的分支）也還沒有實際發過真的 HTTP request 驗證，只驗證了它呼叫的 repository 邏輯。

---

## 2026-09-11（同日追加）— 管理員可逆切換顧客／商家角色並保留資料

**範圍**：`backend/accounts/adminAccountRoleService.js`、`backend/database/repositories/adminAccountRoleRepository.js`（新），`backend/server.js`（新增 `/admin/accounts` 清單與角色切換表單），以及對應測試與產品／架構文件。
**觸發原因**：AGENTS.md 規則自動觸發——這次新增管理員可直接改變帳號有效權限的 auth／authorization 路徑；同時呼應上方 2026-09-11「Firebase 首次登入自動註冊為顧客＋商家核准角色轉換」那筆，確認可逆切換不會破壞既有身份、商家連結或歷史資料。
**方法**：讀完整新 service／repository／測試與 `server.js` 路由、表單渲染；追過 `getUserFromToken`、`authProfileReadRepository`、手機端 `getRouteForUser` 與 session restore；檢查管理員授權、CSRF、輸入驗證、SQL、XSS、併發交易、資料保留、稽核與秘密外洩。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 非管理員能否切換角色 | GET／POST 路由都先經過既有 `requireAdminWebUser`；service 再檢查一次資料庫重新解析出的 `authUser.roles` 必須包含 `admin`。POST 另外使用既有 `readCsrfVerifiedAdminFormBody` 驗證 CSRF，本機 HTTP 實測偽造 token 回 403。 |
| 能否把帳號升成 admin 或修改 admin 帳號 | `targetRole` 白名單只接受 `customer`／`merchant`；後台清單排除任何曾有 `admin` 角色的帳號，repository 在交易內鎖定並再次檢查目標帳號的全部角色，發現 `admin` 就拒絕，避免直接偽造 POST 繞過畫面限制。 |
| 切成商家後是否可能沒有可管理門市 | 啟用 merchant 前必須已有 `merchant_users`→`stores`→`merchants` 關聯且商家主體為 active；一般顧客仍需先走商家申請審核，不能只靠角色切換取得一個無法使用的商家身份。 |
| 資料是否真的保留 | 角色切換只 upsert／update `user_roles.status` 與 `merchant_users.status`，完整查詢與測試確認沒有 `DELETE`；不更新 `users` 身份欄位，也不碰顧客訂單、個人資料、商家、門市或歷史紀錄。切回原角色時重啟既有資料列與門市連結。 |
| 同時切換是否可能留下雙重角色 | 目標 `users` 與 `user_roles` 都在同一個 PostgreSQL transaction 內 `FOR UPDATE` 鎖定；啟用目標角色後再停用另一個 customer／merchant 角色，交易提交前不會暴露半套狀態。重複切到已生效角色為 idempotent no-op，不重複寫稽核紀錄。 |
| 舊 session 是否還能繼續使用被撤銷的 API 權限 | `getUserFromToken` 驗證 token 後會依 `sub` 呼叫 `authProfileReadRepository.getById()`，每次請求都重新讀取 active `user_roles`／`merchant_users`，不信任 token 內舊角色；因此後端撤銷立即生效。手機目前在登出重登或完全關閉後重開的 session restore 才重新路由到新介面，僅從背景切回前景不保證立刻換畫面，但舊介面的受保護 API 已無法通過。 |
| SQL injection／XSS／資料外洩 | 搜尋、userId、角色及稽核資料全部使用 PostgreSQL 綁定參數；後台輸出的姓名、Email、ID、店名、通知與 CSRF 都經既有 `escapeHtml`，路徑 ID 經 `encodeURIComponent`。帳號清單只在已驗證管理員頁面顯示，沒有新增公開查詢端點。 |
| 可追溯性與秘密 | 每次有效變更在同一交易寫入 `admin_account_role_changed`，含操作管理員、目標帳號、先前角色與目標角色；聚焦秘密掃描沒有在這批 feature 檔案發現密碼、資料庫連線字串、Firebase 私鑰或 session secret。 |

### 驗證紀錄與限制

新增 11 個 service／repository 自動化測試，涵蓋非管理員拒絕、角色白名單、admin 保護、商家資料必要條件、顧客→商家、商家→顧客、無 DELETE、角色互斥、稽核、idempotency 與搜尋輸入；完整 `npm test` 115/115 通過，`check:sql-safety` 通過，`node --check` 與 `git diff --check` 通過。本機 HTTP smoke 以現有管理員登入驗證 `/admin/accounts` 回 200、未登入導向登入頁、偽造 CSRF 的 POST 回 403。

為避免未經同意修改現有資料，本次沒有對真實 PostgreSQL 帳號執行有效角色切換；也尚未部署到 Azure 或完成 Android 真機「顧客→商家→顧客」端對端驗證。因此目前可確認的是本機程式切片、權限邊界與 HTTP 守門，不能宣稱正式環境已上線。

---

## 2026-09-11（第二次追加）— 後台顯示全部已註冊帳號

**範圍**：`backend/database/repositories/adminAccountRoleRepository.js`、對應測試與 `backend/server.js` 的帳號清單渲染。
**觸發原因**：使用者要求管理後台看得到所有已註冊帳號，因此清單從原本排除 admin／deleted，改成顯示 `users` 中仍保留的全部帳號。這會擴大管理員頁面可見的個人資料範圍，且涉及管理員帳號保護，所以接續上一筆角色切換審查再做一次聚焦複查。

### 發現與檢查結果

沒有找到信心度達到門檻（8/10 以上）的漏洞。帳號清單仍只能通過 `requireAdminWebUser` 的管理員讀取，沒有新增 Mobile 或公開 API；搜尋仍使用 PostgreSQL 綁定參數，姓名、Email、ID、狀態與店名仍經 `escapeHtml`。admin 與非 active 帳號在 UI 禁用切換按鈕，但安全性不依賴按鈕：POST 路由仍有 session＋CSRF，service 仍要求 admin，repository 仍在交易鎖內拒絕任何具有 admin 角色或非 active 的目標帳號。這批修改沒有新增秘密或將帳號清單送往外部服務。

**驗證限制**：自動化測試已改為確認 active、admin、deleted 三類帳號都能被映射，admin 會帶 `protectedAdmin=true`，同時確認 SQL 不再包含舊的排除條件；實際 Azure 後台尚未部署，沒有用正式帳號清單做畫面端對端驗證。

---

## 2026-09-11（第三次追加）— `/admin/login` 登入失敗鎖定機制

**範圍**：`backend/server.js` 新增的 `adminLoginAttemptsByIp`、`getAdminLoginClientIp`、`getAdminLoginLockoutRemainingMs`、`recordAdminLoginFailure`、`clearAdminLoginFailures`，以及 `GET`/`POST /admin/login` 兩個既有路由的修改。
**觸發原因**：使用者主動要求「登入失敗幾次就先鎖一段時間」，防止 `/admin/login` 被暴力猜密碼；這是新增的 auth 相關程式碼，依規則主動觸發複查。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞，但有兩個刻意接受的設計限制記錄如下（不是漏洞，是這次做法本身的已知取捨）。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 繞過鎖定拿到有效 session | 鎖定檢查在密碼比對之前執行；鎖定中即使密碼正確也一律回 429，不會核發 token，已用真實 HTTP 請求驗證（見下方） |
| SQL injection／資料寫入 | 這次改動完全是記憶體內計數（`Map`），沒有新增或修改任何 SQL 查詢 |
| 資料外洩 | 鎖定訊息只顯示「還要等幾分鐘」，不透露輸入過的密碼、不透露是否有帳號存在（本來就只有單一組共用密碼，沒有帳號枚舉問題） |
| 時間側錄攻擊 | 鎖定判斷在密碼比對之前直接短路，不會執行 `verifyAdminWebPassword`；由於回應狀態碼本身就已經直接告知「目前鎖定中」，短路提早返回不會比現有的 429 狀態碼洩漏更多資訊 |
| 記憶體用量 | 一次只鍵值化少量課堂帳號的 IP，過期紀錄只在同一個 IP 下次查詢時順手清除，沒有主動清除迴圈；對這個規模的課堂展示是合理取捨，重啟後全部歸零 |

### 刻意接受的限制（不是漏洞，是設計取捨）

1. **鎖定用 `X-Forwarded-For` 標頭第一段判斷來源 IP**：這個值在沒有受信任反向代理的情況下可以被 client 偽造，任何人只要每次都夾帶不同的假 IP 就能繞過鎖定。Azure App Service 的前端閘道會如實附上真實來源 IP 且外部連線無法繞過閘道直連後端，所以在**這次要部署的 Azure 環境**下可信；但如果之後把這支程式改到沒有這種受信任代理的環境（例如直接把本機開發伺服器暴露到公網），這個防護會失效，需要重新評估。
2. **同一個 IP 下的鎖定是共用的**：如果多個人（例如同一個學校 Wi-Fi NAT 出去是同一個公用 IP）共用一個對外 IP，其中一人惡意或不小心連續打錯密碼，會連帶鎖到同一個 IP 底下的其他人（包含真正的管理員）15 分鐘。這是這次選擇「用 IP 當 key」這個最簡單做法的已知代價，課堂規模下影響有限，之後如果真的造成困擾，可以考慮改成更細緻的 key（例如 IP + 裝置指紋）。

### 驗證紀錄（真實執行，非記憶體模擬）

啟動本機真實 backend，對 `/admin/login` 直接發真實 HTTP 請求驗證：全新狀態下第一次錯誤密碼正確回 302；連續 5 次錯誤後，第 6 次起正確回 429 且 `GET /admin/login` 頁面正確顯示「登入失敗次數過多，請於 15 分鐘後再試」；鎖定期間即使送出正確密碼也正確被擋在 429、沒有核發 token 或設定 session cookie。`npm test` 115/115 全過（未受影響），`node --check` 通過。

**驗證限制**：沒有實際等滿 15 分鐘驗證鎖定會自動解除，這段是靠讀程式碼確認時間戳比較邏輯正確（`lockedUntil - Date.now()`），不是實際跑滿時間看到解鎖；也還沒有部署到 Azure 用真實 `X-Forwarded-For` 情境驗證。

---

## 2026-09-11（第四次追加）— Azure 課堂展示環境開啟金流相關排程與 LINE Pay sandbox

**範圍**：不是程式碼改動，是 Azure App Service 環境變數設定——開啟 `SETTLEMENT_SCHEDULER_ENABLED`、`PAYMENT_RECONCILIATION_ENABLED`、`PAYMENT_RECONCILIATION_ALLOW_PRODUCTION`、`PICKUP_EXPIRATION_SCHEDULER_ENABLED`，並補上 LINE Pay sandbox 憑證（`LINE_PAY_CHANNEL_ID`／`LINE_PAY_CHANNEL_SECRET`／`LINE_PAY_MERCHANT_ID`／`LINE_PAY_CURRENCY`）與指向 Azure 網址的 `LINE_PAY_CONFIRM_URL`／`LINE_PAY_CANCEL_URL`。
**觸發原因**：使用者要求課堂展示環境的開團、下單、付款成功／失敗、時間到期結算，都要跟正式版行為一致，不要因為展示環境而跳過真正的流程；這是金流相關基礎設施改動，依規則主動觸發複查。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 有沒有不小心開到正式金流 | 逐一讀過三個 production guard 的實際判斷條件（不是憑印象）：`SETTLEMENT_SCHEDULER_ALLOW_PRODUCTION`／`PAYMENT_CAPTURE_RUNTIME_ALLOW_PRODUCTION` 只在 `LINE_PAY_ENV === "production"` 時才有作用，這次維持 `LINE_PAY_ENV=sandbox` 不受影響；`PAYMENT_RECONCILIATION_ALLOW_PRODUCTION` 判斷的是 `NODE_ENV === "production"`（跟金流環境無關），Azure 本來就是 `NODE_ENV=production`，所以這個要設成 `true` 排程才會啟動，這點已經對照 `backend/payments/reliabilityService.js` 原始碼確認 |
| LINE Pay 憑證是否為正式帳密 | `LINE_PAY_API_BASE_URL=https://sandbox-api-pay.line.me`，channel ID／secret 是 LINE Pay 官方提供的測試用 sandbox 憑證（跟本機開發用的是同一組），不是正式商家帳號，這組憑證能處理的請款都是 LINE Pay 自己認定的測試交易，不會動到真實金錢 |
| 回呼網址是否正確 | `LINE_PAY_CONFIRM_URL`／`LINE_PAY_CANCEL_URL` 改成 Azure App Service 自己的 HTTPS 網址加上既有的 `/api/payments/line-pay/confirm`／`/api/payments/line-pay/cancel` 路徑，跟 `backend/server.js` 裡實際註冊的路由逐字核對過一致 |
| 機密外洩 | 這幾個值透過 `az webapp config appsettings set` 指令直接設定，Azure CLI 本身在列出設定時會把值遮蔽成 `null`，沒有印出明文；channel secret 這類值只在使用者自己的 Cloud Shell 裡出現過 |

### 驗證紀錄

`az webapp config appsettings set` 執行後回傳完整設定清單，確認所有新增／修改的變數名稱都正確存在；套用後 App Service 自動重啟，`GET /health` 確認伺服器恢復正常回應。

**驗證限制**：這次只驗證了「設定值正確寫入、伺服器沒有掛掉」，還沒有實際走一次「開團 → 下單 → LINE Pay sandbox 預授權 → 截止結算 → 請款」的完整流程驗證這些排程真的照預期運作；也還沒有實際觸發過一次「付款失敗」情境確認對帳排程正確處理。這些真實流程驗證留待使用者實際操作測試時一併確認。

---

## 2026-09-11（第五次追加）— `/admin` 本機一鍵登入 ＋ 每人獨立信箱密碼登入（Firebase）＋ 授予管理員角色腳本

**範圍**：`backend/server.js`（`GET`/`POST /admin/login`、新增 `POST /admin/login/local-dev`、新增 `POST /admin/login/firebase`、`renderAdminLoginPage`、`resolveAdminWebSessionCookie`）、`backend/firebaseAuth.js`（新增匯出 `getFirebaseAuth`）、新檔案 `scripts/grant-admin-role.js`、`.env.example`（新增 `FIREBASE_WEB_*`）、`package.json`（新增 `admin-role:grant` script）。
**觸發原因**：使用者要求（1）本機開發測試 `/admin` 不用每次輸入密碼；（2）讓管理員可以各自用自己的信箱＋密碼登入（不綁個人 Google 帳號），取代目前唯一一組共用密碼；兩者都是新增／修改的 auth 程式碼，依規則主動觸發複查。呼應上方「2026-09-11（第三次追加）— `/admin/login` 登入失敗鎖定機制」那筆：這次新增的兩個登入路徑（本機一鍵登入、Firebase 信箱登入）都重用同一套 `adminLoginAttemptsByIp` 鎖定機制，確認沒有繞過鎖定的新路徑。

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 中 | `backend/server.js`，`GET /admin/login` | 初版把本機一鍵登入寫成「符合本機＋開發模式條件時，單純 `GET /admin/login` 就自動核發 session」——`GET` 有side effect，任何被動載入的跨來源資源（`<img>`、背景 `fetch`）都能在開發者不知情下觸發，讓瀏覽器被強制登入，擴大了先前只有 `/dev-console`（調時間／模擬定位）才有的本機攻擊面 | 改成一顆需要真人點擊的按鈕，透過**同源** `fetch` POST 到新端點 `POST /admin/login/local-dev` 才核發 session；跨來源頁面无法從外部腳本觸發同源頁面裡的按鈕點擊，Same-Origin Policy 本身就擋掉了 | 已修（本次審查中直接修正，不是留給下次） |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 自助登入是否能直接拿到管理員權限 | `POST /admin/login/firebase` 對「找不到對應帳號」的情況，重用既有 `customerRegistrationRepository.resolveOrRegisterCustomer`（與手機端 `/api/auth/firebase-session` 完全同一段邏輯），新帳號一律只拿到 `customer` 角色；核發 session 前另外檢查 `user.roles.includes("admin")`，身份建立與角色授予是兩個獨立、都通過才放行的步驟，自助建立帳號本身不授予任何權限 |
| 信箱是否可能是假的 | `email_verified` 直接讀自剛驗證過的 Firebase ID token claim（不是前端自報的欄位），未驗證一律擋在 403；`scripts/grant-admin-role.js` 授予角色前另外呼叫 Firebase Admin SDK `getUserByEmail` 即時查證 `emailVerified`，兩處各自獨立檢查 |
| 授予管理員角色的腳本是否可能被網路觸發 | `scripts/grant-admin-role.js` 沒有對應任何 HTTP 路由，只能在有資料庫連線與 Firebase Admin 憑證的本機／伺服器環境用 CLI 直接執行；`/admin/accounts` 既有的自助切換角色頁面白名單仍只接受 `customer`／`merchant`（見 2026-09-11 同日追加那筆），沒有因為這次改動被放寬 |
| SQL injection | `grant-admin-role.js` 全部查詢使用 PostgreSQL 綁定參數（`$1`/`$2`），沒有字串拼接 |
| 新登入路徑是否繞過既有鎖定 | `POST /admin/login/local-dev` 只在本機＋開發模式生效、與密碼鎖定無關；`POST /admin/login/firebase` 的無效 token、信箱未驗證、非管理員三種失敗都呼叫既有 `recordAdminLoginFailure`，成功才 `clearAdminLoginFailures`，跟密碼登入共用同一個以 IP 為鍵的鎖定計數，沒有開一條獨立、不受限的暴力嘗試路徑 |
| 機密外洩 | 新增的 `FIREBASE_WEB_API_KEY`／`FIREBASE_WEB_AUTH_DOMAIN`／`FIREBASE_WEB_APP_ID` 是 Firebase 官方定義的公開網頁設定值（跟手機 App 打包進 bundle 的 `EXPO_PUBLIC_FIREBASE_*` 是同一組），不是密鑰；真正的私密憑證 `FIREBASE_SERVICE_ACCOUNT_JSON` 完全沒有被這次新增的任何路徑讀取或輸出 |
| XSS | 內嵌進 `<script>` 的 Firebase 設定值經 `toInlineScriptJson`（`JSON.stringify` 後跳脫 `</`）處理，且來源是伺服器自己的環境變數，不是使用者輸入 |

### 驗證紀錄

本機啟動真實 backend（連本機 PostgreSQL 與本機已設定的 Firebase 專案）：`node --check` 全部通過；`npm test` 115/115 全過（未受影響）。用瀏覽器與 `curl` 實測：清空 cookie 後單純 `GET /admin/login` 不再核發任何 cookie（修正後的行為）；點擊「本機開發模式：一鍵登入」按鈕（對應 `POST /admin/login/local-dev`）成功核發 session 並可直接讀取 `/admin`；`POST /admin/login/firebase` 送無效 token 正確回 401 `invalid_token`；登入頁在沒有設定 `FIREBASE_WEB_*` 時維持原本純密碼表單、沒有殘留壞掉的 JS 區塊；設定假的 `FIREBASE_WEB_*` 值後，信箱密碼表單、登入／建立帳號切換、錯誤訊息顯示（真實 Firebase 400 錯誤被正確轉成中文提示）皆在瀏覽器人工操作驗證通過，主控台沒有未預期的例外。`scripts/grant-admin-role.js` 對不存在的 email 分別測試 `--revoke`（純資料庫查詢路徑）與一般授予（會先呼叫真實 Firebase Admin SDK 查證）兩種路徑，皆正確回報「找不到帳號」並以結束碼 1 結束。

**驗證限制**：沒有申請真實可用的 Firebase 網頁設定值走完整條「用信箱建立帳號 → 收驗證信 → 點擊驗證 → `grant-admin-role.js` 授予角色 → 用該帳號登入 `/admin`」的端對端流程——這需要使用者自己的 Firebase 專案與真實信箱，屬於使用者需要另外執行的手動設定步驟；也還沒有部署到 Azure（Azure 上 `NODE_ENV=production` 會讓 `本機一鍵登入` 整條路徑直接失效，這點僅由程式碼判斷式確認，沒有部署後實測）。

---

## 2026-09-12 — 手機 App 顧客／商家改用同一套信箱密碼登入

**範圍**：`backend/server.js`（`POST /api/auth/firebase-session` 新增 `email_verified` 檢查、錯誤訊息去 Google 化）、`mobile/src/utils/firebaseAuth.js`（新增 `useFirebaseEmailLogin`：`signUpWithEmail`／`signInWithEmail`／`resetPassword`）、`mobile/src/screens/RoleSelectScreen.jsx`（登入頁新增信箱密碼表單、忘記密碼、`getLoginErrorMessage` 擴充）。
**觸發原因**：使用者要求把「2026-09-11（第五次追加）」只做給管理員的信箱密碼登入，延伸給手機 App 的顧客／商家用，並要求信箱要先驗證；auth 相關程式碼變更，依規則主動觸發複查。呼應上方「2026-09-11（第五次追加）」那筆：這次重用同一套 Firebase 機制，但顧客／商家自助建立帳號成功後**不**像管理員那樣需要額外被授予角色——第一次登入即自動拿到顧客角色，跟現有 Google 登入行為一致。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。這次改動本質上是**限制**（幫既有的自動註冊流程多加一道信箱驗證關卡），沒有新增路由、沒有新增資料庫查詢、沒有放寬任何既有權限，風險面比上一筆本來就小很多。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 是否可能用未驗證信箱建立帳號 | `email_verified` 檢查放在 `customerRegistrationRepository.resolveOrRegisterCustomer(...)` 呼叫之前，未驗證直接 403 並回傳、不建立任何 `users` 資料列；只影響「第一次登入」分支，`getByFirebaseUid` 已找到既有帳號那條路徑完全不受影響 |
| Google 登入是否受影響 | Google 提供的 ID token 的 `email_verified` claim 一律是 `true`（Google 帳號本身就要求信箱已驗證），這次新增的檢查對 Google 登入是穩定通過、不會誤擋 |
| 是否可能藉此拿到比顧客更高的權限 | 這條路徑（`resolveOrRegisterCustomer`）一直以來就只授予 `customer` 角色，這次沒有改動授權邏輯本身，只是在它前面多一道信箱驗證的門檻 |
| 忘記密碼是否會洩漏帳號是否存在 | `resetPassword` 直接呼叫 Firebase 官方 `sendPasswordResetEmail`；Firebase 預設對不存在的信箱一樣回傳成功（避免帳號列舉），這是 Firebase 服務本身的預設行為，不是這次程式碼另外處理的 |
| 錯誤訊息是否洩漏帳號是否存在 | `auth/wrong-password`／`auth/user-not-found`／`auth/invalid-credential` 三種 Firebase 錯誤在 `getLoginErrorMessage` 裡對應同一句「帳號或密碼不正確」，不會讓人從錯誤訊息分辨出「信箱不存在」還是「密碼錯誤」 |
| SQL injection／XSS | 這次後端改動只是一個 `if` 判斷讀取已驗證 token 裡的既有欄位，沒有新增查詢；前端是 React Native 元件（`Text`／`TextInput`），沒有任何 `dangerouslySetInnerHTML` 或等效的原始 HTML 注入點 |

### 驗證紀錄

`npm test` 115/115 全過。用瀏覽器打開真實 Expo web preview（連真實本機 backend 與使用者已設定好的真實 Firebase 專案），實際操作驗證：登入頁正確顯示信箱密碼表單、Google 按鈕與其他既有連結排版未受影響（桌面與手機寬度 375px 皆檢查過）；登入／建立帳號切換正確、「忘記密碼」只在登入模式顯示；實際送出「建立帳號」表單，真的呼叫到 Firebase 並收到 `auth/operation-not-allowed`（因為這個真實 Firebase 專案的 Email/Password 登入方式尚未開啟，屬預期行為，不是本次改動的問題）——這證實表單真的打中 Firebase SDK，不是假資料；過程中發現這個錯誤代碼沒有對應的中文訊息、會直接顯示原始英文錯誤，已補上「信箱登入功能尚未開通，請聯絡系統管理員」並熱重載後重新驗證訊息正確顯示。

**驗證限制**：因為這個真實 Firebase 專案的 Email/Password 登入方式尚未開啟（需要使用者自己到 Firebase Console 開啟），沒辦法驗證到「真的建立帳號成功 → 收驗證信 → 點擊驗證 → 用該帳號登入 → 後端正確建立顧客帳號」這條完整路徑；後端 `email_verified` 檢查目前只靠讀程式碼與 2026-09-11 第五次追加那筆對同一段驗證邏輯（`verifyFirebaseIdToken` 的 claim 讀取方式）的既有驗證結果做交叉確認，還沒有對這個新呼叫點發過一次真實通過驗證的 HTTP request。

---

## 2026-09-12（同日追加）— 種子測試帳號綁定信箱密碼腳本

**範圍**：新檔案 `scripts/bind-seed-firebase-account.js`（`npm run seed-account:bind`）。
**觸發原因**：使用者要求把 `user-customer-yinji`／`user-merchant-001`／`user-admin-001` 這幾個既有種子測試帳號綁上固定的信箱密碼，取代原本壞掉的 `scripts/map-firebase-user.js`（SQLite-only，對現在的 PostgreSQL runtime 沒有作用，見 PROGRESS.md 已知缺口）；使用者確認可以用非真實信箱，因此這支腳本改用 Firebase Admin SDK 直接建立帳號並標記「已驗證」，不走一般自助註冊那套「寄信→點連結」流程。這是新增的、會建立 Firebase 帳號並改變 `users.firebase_uid` 的工具，依規則主動觸發複查。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 是否可能被外部觸發 | 純 CLI 腳本，沒有對應任何 HTTP 路由；執行需要本機 PostgreSQL 連線與 Firebase Admin SDK 憑證（`FIREBASE_SERVICE_ACCOUNT_JSON`），跟 `grant-admin-role.js`／舊版 `map-firebase-user.js` 是同一種「只有掌握伺服器端機密的操作者能執行」的信任邊界，沒有新增可被外部連線到的攻擊面 |
| 強制標記「已驗證」是否等於繞過安全機制 | 這個機制存在的目的是防止「未經證實擁有這個信箱的人」自助宣稱一個信箱；這支腳本改成由**操作者自己指定並確認**要綁定的信箱，等於用另一種方式達成同樣的保證（操作者對這個信箱負責），不是繞過保證本身。僅限這支腳本內部使用，不影響一般使用者自助註冊仍然必須真的收信點連結才能通過 `email_verified` 檢查 |
| 是否可能誤綁到真實使用者的帳號 | 目標預設只認得 `customer`／`customer-a`／`customer-b`／`merchant`／`admin` 這幾個固定種子名稱；若直接填完整 user id 也能用（延續舊工具的彈性），但這次只針對已知的三個種子帳號執行，沒有對任何真實顧客/商家資料操作 |
| `firebase_uid` 唯一性 | 綁定前會先把同一個 Firebase UID 從其他任何 `users` 資料列清掉，避免違反唯一約束或留下兩筆指到同一個 UID 的資料；`user-customer-yinji` 原本殘留的舊 Firebase UID（見 2026-09-11 那筆已知問題）已在這次執行中被正確清除並換成新的 |
| SQL injection | 全部查詢使用 PostgreSQL 綁定參數 |

### 驗證紀錄

對本機真實 PostgreSQL 與使用者真實 Firebase 專案實際執行三次（customer／merchant／admin），執行前後各查一次 `users` 資料表確認：三筆資料的 `firebase_uid`／`email` 皆正確更新，且原本 `user-customer-yinji` 殘留的舊 UID 已被清除、沒有任何資料列意外殘留舊值或指向同一個 UID 的衝突資料。嘗試用剛綁定的顧客帳號信箱密碼在真實 Expo web preview 實際登入，收到 `auth/operation-not-allowed`——這是因為 Firebase 專案本身的 Email/Password 登入方式仍未開啟，屬於使用者尚未完成的手動設定步驟，不是這支腳本或綁定本身的問題（腳本用 Admin SDK 建立帳號不受這個開關影響，但一般使用者用 client SDK 登入時仍會被這個專案層級的開關擋下）。

---

## 2026-09-12（第二次追加）— 使用者開啟 Firebase Email/Password 後，端對端驗證並修好一個 admin 登入 bug

**範圍**：`backend/server.js` 的 `POST /admin/login/firebase`（移除一段邏輯錯誤的檢查）；`backend/.env` 補上 `FIREBASE_WEB_API_KEY`／`FIREBASE_WEB_AUTH_DOMAIN`／`FIREBASE_WEB_APP_ID`（複製自 `mobile/.env` 既有的同一組公開值，非新機密）。
**觸發原因**：使用者在 Firebase Console 開啟 Email/Password 登入方式後，回頭把「2026-09-11 第五次追加」「2026-09-12」「2026-09-12 同日追加」這三筆一直卡在「尚未驗證」狀態的端對端流程實際跑一次；跑的過程中發現一個會擋下所有合法管理員登入的 bug，順手修好，屬於 auth 程式碼變更，依規則觸發複查。

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 中（功能性 bug，非資安漏洞，但會讓合法管理員完全無法用信箱登入） | `backend/server.js`，`POST /admin/login/firebase` | 寫了 `if (user.status !== "active")` 想擋停用帳號，但 `authProfileReadRepository.getByFirebaseUid`／`getById` 的 SQL 本身就已經在 `WHERE` 子句篩選 `status = 'active'`，回傳的物件也從來沒有選取 `status` 這個欄位——`user.status` 永遠是 `undefined`，導致這個判斷式對**每一個**成功找到的使用者都成立，所有信箱密碼登入一律被誤判成「帳號已被停用」而擋下 | 直接移除這段判斷；repository 本身已經保證回傳的帳號一定是 active（否則回傳 `null`／找不到），不需要應用層再檢查一次不存在的欄位 | 已修 |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 移除這段檢查後，停用帳號是否還會被擋下 | 會。`getByFirebaseUid`／`getById` 的 SQL `WHERE user_account.status = 'active'` 本來就會讓停用帳號完全查不到（回傳 `null`），程式碼裡原本就有的 `if (!user)` 分支（透過 `resolveOrRegisterCustomer` 那條路徑）已經涵蓋這個情況，不需要額外判斷 |
| 新增的 `FIREBASE_WEB_*` 是否為機密 | 跟 2026-09-11 第五次追加那筆的結論一致：這是公開網頁設定值，直接複製自 `mobile/.env` 既有的 `EXPO_PUBLIC_FIREBASE_*`，不是新的機密 |

### 驗證紀錄（真實端對端，補齊前三筆一直缺的部分）

使用者在 Firebase Console 開啟 Email/Password 登入方式後，依序實際測試：
1. 顧客（`test-customer-yinji@drinkgroupbuy.test`）：真實 Expo web preview 登入成功，正確進入顧客首頁。
2. 商家（`store1@example.com`）：真實 Expo web preview 登入成功，正確進入「青山手作茶 中科店」商家後台。
3. 管理員（`admin@example.com`）：第一次嘗試遇到上述 bug，回應「這個帳號已被停用」；修復後重新測試，成功進入 `/admin` 後台首頁。

三筆帳號的登入都是對真實本機 PostgreSQL 與真實 Firebase 專案發出的真實請求，不是模擬資料。`npm test` 115/115 全過（bug 修復前後都有跑，確認修復沒有牽動其他行為）。至此「2026-09-11 第五次追加」「2026-09-12」「2026-09-12 同日追加」三筆先前記錄的「尚未完成」端對端驗證缺口，已經補齊。

**驗證限制**：這三個帳號的登入都在本機測試，還沒有部署到 Azure 驗證正式站上的行為；也還沒有測試 Google 登入跟信箱密碼登入交叉出現時（例如同一個信箱先後用兩種方式）的邊界情況，目前只驗證了各自獨立運作正常。

---

## 2026-09-13 — 移除舊版本機密碼登入路徑＋信箱自助註冊改為暫時只開放 Google

**範圍**：`backend/server.js`（移除 `POST /api/auth/login`；新增「自助註冊暫時只允許 Google」的判斷邏輯，分別在 `POST /api/auth/firebase-session` 與 `POST /admin/login/firebase` 兩處）、`backend/auth.js`（移除 `verifyPassword`）、`backend/db.js`、`backend/database/repositories/authProfileReadRepository.js`（移除 `getByLoginIdentifier` 與 `password_hash`／`passwordHash` 欄位讀取）、`mobile/src/utils/apiClient.js`（移除死代碼 `login()`）、`mobile/src/screens/RoleSelectScreen.jsx`（隱藏「第一次使用，建立帳號」入口）。
**觸發原因**：使用者要求「先處理掉」上一輪對話中發現的舊版本機密碼登入殘留機制，並要求信箱自助註冊暫時只開放 Google；屬於 auth 程式碼改動，依 `AGENTS.md` 規則觸發。先自己跑一次 `/security-review`（結論：沒有發現問題——新加的 `sign_in_provider === "password"` 判斷依據是 Firebase Admin SDK 驗證過的 token claim，使用者端無法偽造；移除的舊路徑確認全專案沒有任何呼叫端），跑完後**忘記依規則寫這筆記錄**，直到使用者接著跑 `/code-review`（medium）時，conventions 這個角度直接抓到「改了 auth 程式碼但沒有新增 `docs/AI-security-review-log.md` 記錄」，才回頭補上這筆。

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 低（流程遺漏，非漏洞） | 本檔案 | 完成 auth 改動、跑完 `/security-review` 後沒有依規則寫這筆記錄，是 `/code-review` 的 conventions 角度抓到才補寫 | 已補寫本筆 | 已修 |
| 中（一致性 bug，非資安漏洞） | `backend/server.js`，`POST /api/auth/firebase-session` 與 `POST /admin/login/firebase` 兩處新增的判斷順序 | 原本兩處新判斷的順序不一致：`/api/auth/firebase-session` 是「先判斷是否信箱密碼登入」再判斷 `email_verified`，`/admin/login/firebase` 是反過來（`email_verified` 對每次登入都無條件先檢查）。結果同一種情境（第一次用未驗證信箱的信箱密碼登入）在兩個入口會拿到不同的錯誤代碼（`email_registration_disabled` vs `email_not_verified`），跟兩處註解都寫「同一套政策」不符 | 把 `/api/auth/firebase-session` 的判斷順序對調，改成先檢查 `email_verified` 再檢查 `sign_in_provider`，跟 `/admin/login/firebase` 的優先順序一致 | 已修 |
| 低（文案錯誤，非資安漏洞） | `backend/server.js`，`/admin` 登入頁 `describeBackendError` 裡 `email_registration_disabled` 的訊息文字 | 訊息寫「請聯絡系統管理員以信箱密碼建立管理員帳號」，等於叫使用者去做剛剛被擋下的那件事，實際正確的補救方式是請既有管理員用 `scripts/grant-admin-role.js` 手動授權，訊息內容跟真正的補救步驟矛盾 | 改成「請聯絡已有權限的管理員用 `scripts/grant-admin-role.js` 綁定」 | 已修 |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| `sign_in_provider` 判斷依據是否可被使用者偽造 | 不行。`firebaseUser` 是 `verifyFirebaseIdToken`（Firebase Admin SDK `verifyIdToken`）驗證過簽章的 token 內容，`firebase.sign_in_provider` 是 Firebase 自己核發 token 時寫入的 claim，使用者端沒有簽發金鑰，無法偽造 |
| 既有已綁定的信箱密碼帳號（12 個測試帳號）是否受影響 | 不受影響。這些帳號的 `firebase_uid` 已經由 `scripts/bind-seed-firebase-account.js` 預先寫入 `users` 表，登入時 `getByFirebaseUid` 會直接找到既有帳號，不會進到「第一次註冊」那個分支，新判斷邏輯完全不會碰到 |
| 移除的舊路徑（`/api/auth/login`、`verifyPassword`、`getByLoginIdentifier`、`password_hash` 欄位讀取）是否還有呼叫端 | 全專案（含 `scripts/`、`mobile/`）grep 確認沒有任何殘留呼叫端；唯一使用這些欄位的地方就是被移除的那個路由本身 |
| 資料庫 `users.password_hash` 欄位本身是否一併移除 | 沒有移除 schema 欄位本身——那是額外的資料庫遷移動作，這次沒有一併做，避免在沒有明確要求下多做一個有風險的資料庫變更 |

### 待人工評估（信心度不夠高，沒有列為正式發現，來自 `/code-review` 的 altitude 角度）——已於同日處理，見下方追加

**「Google-only 自助註冊」這個政策只寫在兩個 route 各自的判斷式裡，沒有收斂進 `customerRegistrationRepository.resolveOrRegisterCustomer` 這個共用的註冊機制本身**
- 現況：`resolveOrRegisterCustomer` 的輸入目前完全不知道 `sign_in_provider`，這條政策要收斂進去需要改函式簽章，不是免費的重構
- 風險：以後如果有第三個呼叫端呼叫 `resolveOrRegisterCustomer`（例如新的邀請流程），忘記複製這段判斷就會悄悄繞過這條政策，不會有任何錯誤或紀錄可以抓到
- 目前沒有處理：屬於「如果之後真的加第三個呼叫端」才會浮現的風險，這次沒有動 `resolveOrRegisterCustomer` 的簽章

---

## 2026-09-13（同日追加）— 收斂註冊政策進 repository＋改成 env 開關（呼應上面「待人工評估」與同日稍早那筆）

**範圍**：`backend/database/repositories/customerRegistrationRepository.js`（新增 `signInProvider` 參數與集中判斷、新增 `ALLOW_EMAIL_PASSWORD_REGISTRATION` env 開關）、`backend/server.js`（兩個呼叫點移除各自的判斷式，改成把 `signInProvider` 傳進 repository，並各自把 repository 回傳的 `email_registration_disabled` 轉成對應的 HTTP 回應；同時修正兩處判斷順序不一致與 admin 頁面文案矛盾）、`backend/database/repositories/customerRegistrationRepository.test.js`（新增 4 筆測試）。
**觸發原因**：使用者跑完 `/code-review` 後看到上面「待人工評估」與另外兩筆設計建議，回覆「處理」——把 4 筆待處理事項處理掉，其中「信箱登入畫面的建立帳號入口／底層邏輯」使用者明確說要保留不動（只是先把入口拿掉），所以這筆不算採納，其餘 3 筆（政策收斂進 repository、改成 env 開關、順帶清掉同一份 code 裡的重複判斷）都實際處理。

### 這次改了什麼

1. **政策收斂進 `resolveOrRegisterCustomer`**：新增 `signInProvider` 輸入欄位，在「確認是全新帳號」之後、真的寫入資料庫之前，判斷 `signInProvider === "password"` 且 `ALLOW_EMAIL_PASSWORD_REGISTRATION`（env，預設關閉）未開啟時回傳 `{ error: "email_registration_disabled" }`，不寫入任何資料列。兩個呼叫端（`POST /api/auth/firebase-session`、`POST /admin/login/firebase`）不再各自判斷，只負責把 `firebaseUser.firebase?.sign_in_provider` 傳進去、把回傳的錯誤代碼轉成 HTTP 回應——之後任何新呼叫端都會自動套用同一條規則。
2. **改成 env 開關**：新增 `ALLOW_EMAIL_PASSWORD_REGISTRATION`（布林 env，預設關閉，跟其他 env 開關一樣的 `readBooleanEnv` 判斷方式）。要重新開放信箱密碼自助註冊，後端只需要設這個 env，不用改程式碼、不用重新部署程式；但 Mobile 端「第一次使用，建立帳號」入口目前仍刻意隱藏（使用者明確要求保留底層邏輯、只拿掉入口），要重新顯示是另一個獨立的前端決定，需要另外改 App 並重新發版。
3. **順帶修掉檢查順序**：兩個呼叫端原本各自判斷順序不一致的問題，隨著改成呼叫共用函式自然消失——不會再有「同一種情境兩個入口回傳不同錯誤碼」的狀況。
4. **錯誤代碼字串收斂成單一常數**：`email_registration_disabled` 這個字串改成只在 `customerRegistrationRepository.js` 定義一次（`EMAIL_REGISTRATION_DISABLED_ERROR`），`backend/server.js` 的兩處都改成 `require` 這個常數，包含 `/admin/login` 頁面內嵌 `<script>` 那段——因為那整段本來就是 Node 的 template literal，用 `${EMAIL_REGISTRATION_DISABLED_ERROR}` 直接內插即可，不用另外傳參數。Mobile 端 `RoleSelectScreen.jsx` 因為是完全獨立的 React Native bundle、跟後端沒有共用模組系統，這個字串仍然維持獨立寫死一份——這是這個專案所有錯誤代碼原本就有的既定模式（`email_not_verified`／`not_admin` 等都是這樣），不是這次改動特有的問題，所以沒有連這個也一起處理。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 既有已綁定的信箱密碼帳號是否受影響 | 不受影響。新的判斷式放在「確認資料庫裡沒有這個 `firebase_uid`」之後，既有帳號一律在更早的 `existing.rows[0]` 分支就回傳了，不會碰到新判斷 |
| `resolveOrRegisterCustomer` 既有的呼叫端／測試是否因為新增 `signInProvider` 參數而壞掉 | 沒有。這個參數是新增的可選欄位，沒帶的話 `signInProvider !== "password"` 恆成立，行為跟改動前一致；原本 5 筆測試全過 |
| 新增的 4 筆測試涵蓋範圍 | 涵蓋：首次信箱密碼註冊被擋、首次 Google 註冊不受影響、已預先綁定的信箱密碼帳號仍可登入、`ALLOW_EMAIL_PASSWORD_REGISTRATION=true` 時信箱密碼註冊恢復正常 |
| 伺服器啟動與 `/api/auth/firebase-session` 是否還能正常回應 | 重啟本機後端後，`GET /health` 回 200；對 `/api/auth/firebase-session` 送一個假 token 正確回 401 與可讀的錯誤訊息，沒有 crash |

---

## 2026-09-13（第三次追加）— 已預授權訂單改單，最後 30 分鐘只擋「減少」不擋「增加」

**範圍**：`backend/database/repositories/orderRevisionRepository.js`（`createPostgresOrderRevision` 的截止前鎖定判斷）、`backend/db.js`（SQLite 對應的 `createOrderRevision`，以及 `getCustomerOrderAvailableActions` 把 `edit`／`cancel` 兩個動作拆開判斷）、`mobile/src/screens/CartScreen.jsx`（購物車畫面的改單/追加文案與按鈕邏輯，並移除 `pending`〔尚未預授權〕訂單原本多餘的前端 30 分鐘鎖）、`mobile/src/screens/CustomerOrdersScreen.jsx`（訂單頁逐項編輯／刪除的鎖定判斷拆開，並補上顯示 `order.revisionError`）。
**觸發原因**：使用者要求「已有訂單後能不能追加飲料」這個既有功能，改成截止前 30 分鐘鎖定期間依然可以增加飲料，只有「總杯數變少」才擋——原本的規則是整個鎖定期間完全不能改單（不管加減）。過程中跟使用者來回討論多輪：先確認「總杯數不可減少」是判定基準（不是逐項品項）、確認整筆取消訂單維持不可以（等同減到 0）、討論過給緩衝時間讓最後一刻下單的人有時間預授權（方案 A／B），最後使用者決定不做緩衝，維持「沒完成預授權就是訂單失敗」的現況不動。屬於訂單金額／付款相關邏輯改動，依 `AGENTS.md` 規則自動觸發，主動跑這次審查。

### 這次改了什麼

1. **核心規則**：`createPostgresOrderRevision`／`createOrderRevision` 原本只要進入 `withdrawalLockMinutes`（預設 30 分鐘）鎖定期，任何改單一律拒絕（回傳 `order_locked_by_deadline`）。改成只有當「新的總杯數 `totalCups` 小於訂單目前的總杯數 `order.total_cups`」時才拒絕；新總杯數大於等於原本，即使在鎖定期內也放行。
2. **`getCustomerOrderAvailableActions`（`db.js`）**：原本 `edit`／`cancel` 兩個動作綁在同一個 `!locked` 條件下，一起開關。拆開後 `edit` 不再受 `locked` 影響（因為編輯方向不確定，可能加也可能減，實際擋不擋由寫入當下的 `createOrderRevision` 判斷），`cancel` 維持只在 `!locked` 才給，跟「整筆取消＝減到 0，鎖定期內不可以」這條規則一致。
3. **Mobile 端**：`CartScreen.jsx` 新增 `wouldDecreaseCups`（比較購物車總杯數與既有訂單總杯數）跟 `blockedByWithdrawalDecrease`，畫面文案跟著這兩個新狀態分流；同時把 `pending`（尚未預授權）訂單的前端 30 分鐘鎖拿掉，因為查證後端從來沒有這條限制（後端只用真正的截止時間擋，見 `customerOrderWriteRepository.js:366` 的 `updatePostgresPendingOrder`），前端這條鎖是多餘的、擋住了顧客本來合法能做的事。`CustomerOrdersScreen.jsx` 把逐項「編輯」（方向不確定，維持可點）跟「刪除整個品項」（必定是減少，鎖定期內繼續擋）的可操作狀態拆開，並補上顯示 `order.revisionError`（這個欄位之前就存在、但畫面上從沒渲染過，是個既有的靜默失敗缺口——這次因為編輯在鎖定期內更容易觸發「減少被拒絕」，順便補上顯示，不然使用者點了刪除／編輯卻什麼提示都沒有）。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。用一個 sub-task 針對五個具體疑慮（`totalCups` 型別混淆繞過、容量/折扣驗證與 row lock 是否還在、有沒有繞過訂單歸屬檢查、`revisionError` 在 React Native `<Text>` 有沒有注入風險、`edit` 動作放寬會不會讓前端繞過後端驗證）逐一查證，結論都是否定——細節見下方「沒發現問題的部分」。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| `totalCups`／`order.total_cups` 型別混淆是否能讓比較式失效（例如變成 NaN 恆為 false，等同繞過鎖定） | 不行。`totalCups` 是伺服器端用已驗證過的品項算出來的（`customerOrderWriteRepository.js` 對每個品項的 `quantity` 先檢查 `Number.isInteger(quantity) && quantity > 0`，不合法直接拒絕，不會走到鎖定判斷），`order.total_cups` 在 Postgres 版本有明確 `Number(...)` 轉型、SQLite 版本本身欄位型別就是 INTEGER，兩邊都不存在字串比較或 NaN 繞過的路徑 |
| 容量檢查、折扣驗證、`FOR UPDATE` row lock 是否還完整套用在兩個分支（放行／擋下）上 | 都還在，而且都在這次改動的那一行判斷之前或之後、沒有被新加的分支跳過——讀完整個函式確認過，這次 diff 只改了單一行的判斷條件，沒有動到前後的驗證步驟 |
| 訂單歸屬檢查（`order.customer_user_id !== input.customerUserId`）是否還在新邏輯之前執行 | 是，這個檢查在改動的那一行之前就先執行，沒有被繞過 |
| `order.revisionError` 用 React Native `<Text>` 顯示會不會有注入風險 | 不會。React Native 的 `<Text>` 純文字渲染，不解析 HTML，也沒有用到任何等同 `dangerouslySetInnerHTML` 的 API |
| `edit` 動作在鎖定期內放寬後，會不會讓前端繞過後端重新驗證 | 不會。`availableActions` 只控制畫面上按鈕能不能按，實際寫入的 `createOrderRevision`／`updatePostgresPendingOrder` 仍然是唯一的權威判斷點，不管前端顯示什麼，後端都會重新算一次總杯數並獨立拒絕真正的減少 |

---

## 2026-09-13（第四次追加）— `/code-review` 抓到「截止後仍可加購」與「Postgres 從沒給過 edit/cancel」兩個真的問題，已修

**範圍**：延續上一筆（第三次追加）的改動，這次是使用者跑完 `/code-review`（medium，8 個角度）後回報的 8 筆發現，全部「處理」（修復）。實際改動：`backend/database/repositories/orderRevisionRepository.js`、`backend/db.js`（新增獨立於「是否減少」判斷之外、不管加減都必擋的「已過真正截止時間」檢查）、`backend/database/repositories/customerOrderReadRepository.js`（把 SQLite 版 `getCustomerOrderAvailableActions`／`getMerchantOrderAvailableActions` 的邏輯移植進 Postgres 版 `getPostgresAvailableActions`，這個函式先前只會回傳 `["pay"]` 或 `[]`，從來沒有過 `edit`／`cancel`）、`mobile/src/screens/CustomerOrdersScreen.jsx`（`canDeleteItem` 改成對 `pending` 訂單不套用鎖定判斷）、`mobile/src/screens/GroupBuyActivityDetailScreen.jsx`（更新過期文案）、`mobile/src/utils/orderWriteErrors.js`＋對應測試（改錯誤訊息文字，不再暗示「完全無法修改」）、`mobile/src/screens/CartScreen.jsx`（清掉重複的通知文字與重複計算的 `quantityDelta`）。
**觸發原因**：使用者對上一筆改動跑 `/code-review`（medium 強度，附帶「並且跑幾次情境確認」的要求），8 個角度找出 8 筆候選，逐一驗證後全部確認為真（6 筆 CONFIRMED、2 筆 PLAUSIBLE），使用者回覆「處理」要求全部修復。屬於訂單／付款相關邏輯改動，依 `AGENTS.md` 規則自動觸發本次審查。

### `/code-review` 找到、這次修掉的問題

| 嚴重度 | 位置 | 問題 | 修法 | 狀態 |
|--------|------|------|------|------|
| 高（真的可被利用的邏輯漏洞） | `orderRevisionRepository.js:109`、`db.js:2155` | 上一筆改動把「截止前 30 分鐘鎖定」的判斷式改成「只擋減少」，但這個判斷式的算法（`deadlineTime - nowTime <= lockMinutes`）本身沒有上限，過了真正的截止時間之後這個算式依然成立——舊版程式碼靠「鎖定期間一律擋」順便把「截止後也一律擋」這件事也一起做掉了；改完之後，只要活動狀態還沒被結算排程（每 30 秒跑一次）從 `recruiting`/`confirmed` 切走，過了截止時間仍然可以送出「增加」的改單請求 | 新增一個獨立、不管加減都必擋的「是否已過真正截止時間」檢查，放在原本的「是否減少」判斷之前 | 已修 |
| 中（設計不一致，非資安漏洞） | `CustomerOrdersScreen.jsx:214` | 新增的 `canDeleteItem = canEdit && !withdrawalLocked` 沒有排除 `pending`（尚未預授權）訂單，導致鎖定期間內連刪除品項都被擋下——跟同一筆改動裡 `CartScreen.jsx` 明確講的「pending 訂單完全沒有後端鎖定」自相矛盾 | 改成 `pending` 訂單直接跟著 `canEdit` 走，不套用 `withdrawalLocked` | 已修 |
| 中（既有缺口，這次順便補上，讓改動真的生效） | `customerOrderReadRepository.js:394`（`getPostgresAvailableActions`） | 這個函式是 SQLite 版 `getCustomerOrderAvailableActions` 的 Postgres 對應版本，但先前一直只回傳 `["pay"]` 或 `[]`，從來沒有 `edit`／`cancel` 邏輯——因為 `AGENTS.md` 明訂 PostgreSQL 是唯一永久 runtime，代表上一筆改動對 `CustomerOrdersScreen.jsx` 逐項編輯畫面做的鎖定放寬，實際上完全沒有機會在正式環境生效（`hasBackendActions` 恆為 true 但陣列裡永遠沒有 `"edit"`） | 把 SQLite 版的邏輯（含這次新加的鎖定放寬規則）移植進 Postgres 版，兩邊改用同一套規則 | 已修 |
| 低（文案跟新規則脫節） | `GroupBuyActivityDetailScreen.jsx:84` | 沒被這次改動碰到的畫面，文案還寫「既有訂單不可修改或退出」，跟新規則（可以增加、只是不能減少）矛盾 | 改成「既有訂單只能增加飲料，不能減少或退出」 | 已修 |
| 低（註解跟實際行為不符） | `db.js:3211`、`CustomerOrdersScreen.jsx:208` | 註解寫「在 `createOrderRevision`／`updateOrder` 寫入時擋下減少」，但 `updateOrder`（給 `pending` 訂單用）本來就沒有任何鎖定檢查——以後如果有人照著這句註解的字面意思去改 `updateOrder`，可能會誤以為保護已經存在而漏掉真正該加的檢查 | 改寫註解，講清楚 `updateOrder` 目前沒有鎖定檢查是因為 `pending` 訂單本來就不受這條規則限制 | 已修 |
| 低（重複程式碼） | `CartScreen.jsx`（兩處通知文字、`wouldDecreaseCups`／`capacityCheckQuantity`） | 同一句提示文字被複製貼上兩次；`totalQuantity - existingOrder.quantity` 這個差值也被兩個地方各自重算一次 | 抽成 `withdrawalLockedNoticeText`／`quantityDelta` 兩個共用變數 | 已修 |
| 低（訊息文案過度概括） | `orderWriteErrors.js:31` | `order_locked_by_deadline` 的訊息文字寫「已無法修改」，聽起來像完全鎖死，但這個錯誤現在只會在「嘗試減少」時才會出現，實際上還是能增加 | 改成「只能增加飲料、無法減少」，同步更新對應的兩個測試斷言 | 已修 |

### 沒發現問題的部分（這次額外確認）

| 面向 | 檢查結果 |
|------|----------|
| 新增的「已過真正截止時間」檢查會不會誤擋合法的鎖定期內操作 | 不會。這個檢查只在 `nowTime >= deadlineTime`（真正過了截止時間）才成立，鎖定期間但還沒到截止時間的情境不受影響，原本「只擋減少」的規則照舊 |
| `getPostgresAvailableActions` 補上邏輯後，會不會意外放寬商家端（`merchant` 角色）原本沒有的權限 | 不會。商家端的 `markReadyForPickup`／`redeemPickup` 邏輯是原封不動照抄 SQLite 版本的既有條件，沒有新增或放寬任何判斷 |
| `getPostgresOrderDetail` 目前把 `pendingRevision` 固定寫死成 `null`，會不會讓新的 `getPostgresCustomerAvailableActions` 誤判 | 這是既有缺口（`order_revisions` 資料表還沒接進 Postgres 讀取路徑），這次沒有動它，只是在程式碼裡用註解明確標註「這個值目前恆為 null」，避免以後有人誤以為這裡已經處理過 pending revision 的情境 |

**驗證限制**：`npm test` 119/119 全過（含更新後的 `orderWriteErrors.test.mjs` 兩個斷言）；`node --check` 對全部改動檔案語法檢查通過；Mobile 端 Metro 重新打包確認無編譯錯誤、瀏覽器 console 無錯誤。**跟上一筆一樣，這次依然沒有針對「鎖定期內加購／減購」「過了截止時間後嘗試加購」這兩個情境做真正的端對端測試**——需要對開發資料庫寫入測試資料，還沒有取得使用者同意執行，維持原本記錄的已知驗證缺口。

---

## 2026-09-13（第五次追加）— 補齊前兩筆一直留著的「鎖定期情境」端對端驗證缺口

**範圍**：新增 `scripts/order-revision-withdrawal-lock-smoke.js`（唯一新檔案，`npm run order-revision-withdrawal-lock:smoke` 可重跑），對真實本機 PostgreSQL dev 資料庫實際執行四個情境，不是模擬資料。`package.json` 新增對應的 script 別名。
**觸發原因**：使用者明確同意（「跑」）補做前兩筆記錄裡一直列為「已知驗證缺口」的端對端測試，針對這次改動的核心規則做真實資料庫層級的驗證。

### 測試內容與結果

跟著 `scripts/order-revision-postgres-smoke.js` 既有的手法（用真實存在的顧客帳號、建立一批帶有唯一亂數 ID 的隔離測試活動／訂單，測完在同一個 transaction 裡刪乾淨，最後查一次殘留數量確認歸零），這次額外建立四個情境：

| # | 情境 | 預期結果 | 實測結果 |
|---|------|----------|----------|
| 1 | 已授權訂單，活動還有 10 分鐘到截止（在 30 分鐘鎖定窗內），送出「增加」改單（2 杯→3 杯） | 應該成功 | ✅ 成功建立 revision |
| 2 | 同上設定，送出「減少」改單（2 杯→1 杯） | 應該被擋（`order_locked_by_deadline`） | ✅ 正確被擋 |
| 3 | 已授權訂單，活動截止時間是 1 分鐘前（真的已經過了截止時間，但刻意讓 `activity.status` 還停在 `recruiting`，模擬結算排程還沒來得及把狀態切走的那個競態窗口），送出「增加」改單 | 應該被擋（這正是這次 `/code-review` 抓到、剛修好的那個漏洞） | ✅ 正確被擋，確認修法有效 |
| 4 | 尚未預授權（`pending`）訂單，活動還有 10 分鐘到截止，直接呼叫 `updatePostgresPendingOrder` 送出「減少」（2 杯→1 杯） | 應該成功（pending 訂單本來就沒有鎖定） | ✅ 成功更新 |

四個情境全部符合預期，包含這次 `/code-review` 修的那個「過了截止時間仍可增加」的漏洞，也已經用真實資料庫操作反向證實：改之前會失敗（放行不該放行的增加）、改之後正確擋下。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 測試資料是否有殘留、污染既有種子資料 | 沒有。四個情境用的活動／訂單／顧客 ID 全部帶唯一亂數字串，且顧客帳號本身是重複使用既有的 4 個真實測試帳號（不新建帳號），清理後對 `group_buy_activities`／`orders`／`order_revisions`／`payment_authorizations`／`audit_logs` 五張表各自查詢殘留數量，全部為 0；額外用獨立查詢（`title = 'PostgreSQL Withdrawal-Lock Proof'`）二次確認沒有任何測試活動遺留 |
| `updatePostgresPendingOrder` 的回傳結構是否跟預期一致 | 第一次執行時斷言寫錯（誤以為 `totalCups` 在回傳物件最外層，實際上巢狀在 `result.order.totalCups` 底下），跑出來就直接抓到並修正，不是靠讀程式碼猜對的 |

**驗證限制**：這次驗證的是 repository 層直接呼叫（`createOrderRevision`／`updatePostgresPendingOrder`），不是走完整 HTTP／LINE Pay 流程，跟 `order-revision-postgres-smoke.js` 既有的驗證深度一致；沒有另外對 Azure 正式環境重跑一次。至此，前兩筆記錄裡留著的「鎖定期情境」端對端驗證缺口已經補齊。

---

## 2026-09-14 — 取貨憑證 lease 時鐘不一致修正（SQLite 相容性路徑）

**範圍**：`backend/pickup/credentialService.js`（`markGroupBuyActivityReadyForPickup`、`redeemPickupCode` 各一行新增 `now: input.now`），未動 Postgres 路徑（`backend/database/repositories/pickupCredentialRepository.js`）
**觸發原因**：`npm run pickup-credential:smoke` 斷言「activity lease should block ready transition」失敗（已用 git checkout 回測到今天稍早的 80428db 確認是既有問題、不是這次金流 `/code-review` 修正批次造成的迴歸），使用者要求診斷、修復並依高風險區域規則留安全複查記錄。

### 診斷

`backend/reliability/operationLease.js` 的 `createLease()` 會把 `input.now` 轉傳給 `backend/db.js` 的 `acquireOperationLock`，後者用 `current.locked_until > now`（`now` 未提供時退回 `Date.now()`）判斷既有鎖是否已過期。修正前，`credentialService.js` 裡呼叫 `withOperationLeaseSync(...)` 時沒有把呼叫端傳入的 `input.now`（測試用的模擬時間 `2026-07-29T10:00:00.000Z`）一併轉傳，導致鎖的過期判斷退回真實系統時間（今天 2026-09-14），而測試用模擬時間算出的 `locked_until` 遠早於真實今天，鎖被誤判成早已過期，直接被覆蓋、沒有真的擋下轉換。

### 這次改了什麼

`markGroupBuyActivityReadyForPickup`、`redeemPickupCode` 兩處呼叫 `withOperationLeaseSync` 的 options 都加上 `now: input.now`，讓 lease 的過期判斷跟同一次呼叫裡其餘業務邏輯（`markGroupBuyActivityReadyForPickupUnlocked`、`accessPickupCode` 內部的 `const now = input.now || new Date().toISOString();`）使用同一個時間基準。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。用一個獨立 sub-task 交叉檢查：`input.now` 在 HTTP 路由層一律來自伺服器端 `businessClock.nowIso()`，不會讀取 request body／query／header；能移動 `businessClock` 偏離真實時間的唯一入口 `PUT /api/dev/business-time` 有三層防護（`isDevAuthModeEnabled()`、`isLoopbackRequest` 拒絕非本機呼叫、`NODE_ENV=production` 時直接拋錯，且偏移量鎖在 7 天內），沒有客戶端可操控的路徑能影響這個欄位。正式 Postgres runtime 也不會走到這段被改動的程式碼（走的是另一條未變動的 `repository.withOperationLock`）。

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| `now` 是否可被客戶端操控來繞過 lease | 否；僅來自伺服器端 `businessClock.nowIso()`，且 dev-only 時間覆寫入口有 loopback＋非 production＋7 天封頂三層限制 |
| 這次改動是否影響授權／SQL／回應內容 | 否；純粹在既有 options 物件多加一個欄位，沒有動 `actorUserId`、門市歸屬檢查、SQL 組裝或回應欄位 |
| 是否引入新的信任關係 | 否；`input.now` 在同一次呼叫裡本來就已經被業務邏輯信任（`markGroupBuyActivityReadyForPickupUnlocked`／`accessPickupCode` 既有的 `now` 讀取），這次只是讓 lease 檢查跟既有用法時間基準一致 |
| Postgres 路徑是否受影響 | 未修改 `pickupCredentialRepository.js`；`npm test` 全跑後沒有出現新的失敗 |

**已記錄但這次刻意不修的相關發現**：`markGroupBuyActivityReadyForPickup`／`redeemPickupCode` 的 Postgres 分支（`repository.withOperationLock({ activityId }, ...)`，`backend/pickup/credentialService.js` 約 12 行、無 `now` 轉傳）有相同形狀的潛在問題——正式環境呼叫端目前一律不傳明確 `now`（兩端都退回真實 `Date.now()`，時間差在毫秒等級、實務上不構成問題），所以判斷為非緊急，但屬於同一類「業務時鐘與 lease 時鐘可能不一致」的設計疑慮，這次範圍明確排除 Postgres 路徑，已另外用 `spawn_task` 開一張獨立任務追蹤，不在此筆記錄內視為已解決。

**驗證限制**：`npm run pickup-credential:smoke` 完整腳本（含 `ready_transition_blocked`、`redeem_transition_blocked` 兩個斷言）通過；`npm test` 138 個測試裡 135 通過、3 個既有失敗（`backend/payments/orderRuleConsent.test.js`，錯誤為 `no such table: main.orders`）——已確認在完全不牽涉這次改動程式碼的情況下單獨執行該測試檔案一樣會失敗，錯誤堆疊只經過 `linePayService.js`／`db.js`，且本機 `database/drink-group-buy-dev.sqlite`（gitignored、未追蹤）目前只有 2 張表、缺少 `orders` 等主要資料表，判斷是這個 worktree 本機開發 DB 初始化不完整的既有環境問題，與這次修改無關，未嘗試用 `db:init`／migration 動這個共用開發資料庫去「修好」它。

**驗證限制**：`npm test` 119/119 全過（無回歸）；`node --check` 語法檢查通過；Mobile 端透過 Metro 重新打包確認無編譯錯誤、瀏覽器 console 無錯誤。**這次沒有針對新規則寫自動化測試**——`orderRevisionRepository.js` 這個檔案本身目前完全沒有既有的單元測試（只有一支需要連真實 PostgreSQL 的 `scripts/order-revision-postgres-smoke.js`，且該腳本目前也不涵蓋鎖定期情境），要驗證這次改動需要真的跑一次「已授權訂單、卡在鎖定期內分別嘗試加購／減購」的情境，這需要對使用者的開發資料庫做寫入操作，還沒有取得使用者同意執行，屬於已知的驗證缺口，留待使用者確認後補做。


## 2026-09-13 — 單筆訂單標記可取餐

**範圍**：`backend/server.js` 的標記可取餐路由、`backend/pickup/credentialService.js`、`backend/database/repositories/pickupCredentialRepository.js` 與 Mobile 呼叫路徑。
**觸發原因**：新增訂單範圍輸入與授權相關流程的 diff 複查。

### 發現

本次 diff 未發現注入、越權、金額竄改或機密外洩問題。

### 沒發現問題的部分

- `POST /api/merchant/group-buy-activities/:id/ready-for-pickup` 可選 JSON `orderId`；省略時沿用整批操作，提供時必須是非空字串，明確傳入 null 不會退回整批。
- 路由維持登入與 merchant 角色檢查；PostgreSQL 查詢維持 active 門市關聯限制，訂單以活動 ID 與訂單 ID 共同篩選。
- 訂單 ID 使用參數化查詢；只允許已 capture、未取消且尚未取餐的訂單，沒有接受金額或客戶端付款狀態。
- 沿用活動 lease、transaction、FOR UPDATE、取餐碼重用與狀態歷程；audit metadata 記錄單筆 orderId。
- 未更改金流 provider 或機密設定。6 項隔離測試通過；未執行真實資料庫、HTTP 或 Android E2E，因此不作跨程序併發驗收聲明。


## 2026-09-13 — 單筆取餐舊後端相容性修正

**範圍**：取餐 HTTP 路由、PostgreSQL runtime gate、Mobile API client。
**觸發原因**：使用者實測單筆按鈕造成整批標記；執行中的舊後端忽略新增的 body orderId，audit 顯示一次更新 3 筆且沒有 orderId metadata。

### 發現

單筆共用整批 URL 對舊後端不安全，已改為 `/api/merchant/group-buy-activities/:activityId/orders/:orderId/ready-for-pickup`，舊後端不匹配此路由；整批保留原 URL。

### 沒發現問題的部分

- 新路由沿用身份、商家門市授權與 PostgreSQL gate，訂單路徑參數沿用參數化查詢；未更動付款金額或 provider。
- 12 項相關測試通過，實際 PostgreSQL 指定訂單只回傳該筆憑證（交易回滾）；本機後端已重啟，health 正常，新路由未登入回覆 Authentication required。
- 尚未重新完成 Android 全流程操作；既有已標記訂單沒有重設。


## 2026-09-13 — 單筆取餐 review 問題修正

**範圍**：PostgreSQL／SQLite 商家可用操作判斷、Mobile 模擬請款 pickupStatus 與回歸測試。
**觸發原因**：處理 code review 的兩項狀態一致性問題。

### 發現

- 已修正活動開始供餐後，其餘待製作訂單缺少 markReadyForPickup 的問題；操作清單限已請款且 not_ready 訂單。
- 模擬請款維持 not_ready，並將既有 preparing 相容值轉回 not_ready；ready／picked_up 不會被重設。

### 沒發現問題的部分

未變更實際金流 provider、金額計算、登入或門市權限；新增的是操作提示規則，寫入路由仍執行既有授權與交易控制。17 項相關測試通過；PostgreSQL 三筆訂單回歸測試涵蓋單筆、重複、部分取餐、整批與最終完成，使用備份及交易回滾確認原資料不變，沒有呼叫金流。完整 HTTP／Android 流程尚待驗證。

## 2026-09-15 — 修改訂單（加購）漏掉既有品項並回填搜尋半徑安全審查

**範圍**：`mobile/src/navigation/AppNavigator.js`（`submitCart` 的訂單修改／加購邏輯與容量預檢）、`mobile/src/components/ActivityFilterPanel.jsx`（搜尋半徑安全區域 padding，非金流，一併審查因同批改動）。
**觸發原因**：使用者回報「已有訂單後加購，沒有跳出 LINE Pay」；追查後發現「修改訂單」流程只把購物車裡新選的品項送給後端，`order_revisions`／pending 訂單更新兩條路徑後端都是整批替換品項清單，導致既有品項被靜默蓋掉——屬於改到送進 LINE Pay 預授權金額的邏輯，依規則主動跑一次 `/security-review`。

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。有一項相關的**正確性**問題（非安全漏洞，已一併修正）：合併品項後，既有的容量預檢公式（`quantity - existingOrder.quantity`）沒有同步更新，會讓前端的「已達上限」提示失效；已改為已授權訂單用純新增杯數（`quantity`）、待授權/全新訂單用合併後總杯數（`finalQuantity`）。

### 沒發現問題的部分

- **金額竄改**：`orderRevisionRepository.js` 的 `createPostgresOrderRevision` 與 `customerOrderWriteRepository.js` 的待授權訂單更新，都會呼叫 `pricePostgresOrderItems` 依店家菜單重新計價，客戶端送來的 `unitPrice`／`subtotal` 一律不被信任，價格不符直接回傳 `order_price_changed`。
- **權限**：兩條路徑都重新比對 `order.customer_user_id` 與登入者 token 對應的使用者 id，不是信任客戶端帶來的任何欄位；合併進去的 `existingOrder.items` 本來就是同一顧客自己訂單的資料，不會跨顧客外洩。
- **容量上限**：後端各自用完整合併後的品項清單重新加總杯數並比對活動上限，跟本次修正的前端預檢公式無關；前端公式錯誤最多只是少顯示一則提醒訊息，不影響後端最終是否放行。
- 惡意使用者原本就能直接打 API 帶任意 `items` 陣列（這是既有、已經過驗證的攻擊面），本次修正只是讓「正常使用者」送出的內容變得正確，沒有擴大攻擊面。
- `ActivityFilterPanel.jsx` 的改動純屬版面 padding（避免搜尋面板底部被 Android 系統手勢列擋住），不涉及任何資料流或權限，無安全影響。
- `npm test` 138/138 全過；另外用本機真實 PostgreSQL 手動走過兩次端對端情境（單一新品項、以及新增 3 杯的不同品項），確認合併後的 `order_revisions`／`order_revision_items` 金額與杯數正確（$105／2 杯、$235／4 杯），且未誤觸容量預檢。

## 2026-09-18 — 團購優惠改成百分比折扣（金額折扣 → 打折）

**範圍**：`backend/pricing/groupBuyDiscount.js`（核心折扣計算重寫）、`backend/database/repositories/groupBuySettlementRepository.js`（LINE Pay 實際請款金額計算）、`groupBuyActivityWriteRepository.js`／`groupBuyActivityReadRepository.js`（活動建立／讀取）、`customerOrderWriteRepository.js`／`orderRevisionRepository.js`／`merchantMenuRepository.js`／`merchantMenuImportRepository.js`（移除了幾個舊制專屬的價格下限驗證函式）、`backend/db.js`（SQLite 相容路徑鏡像同步改寫）、`backend/payments/settlementService.js`、新增 migration `database/migrations/008_percentage_discount_postgres.sql`，以及對應的 Mobile 顯示/輸入邏輯。
**觸發原因**：使用者要求把「滿N杯折固定金額」改成「滿N杯打折」；這是會改到 LINE Pay 實際請款金額計算方式的金流改動，依規則主動跑一次 `/security-review`。

### 發現

沒有找到信心度達到門檻（6/10 以上，本次以較寬鬆門檻篩選候選後仍全數排除）的漏洞。

### 沒發現問題的部分

- **移除的驗證函式沒有夾帶授權/注入邏輯**：追查 `findOrderDiscountConflicts`／`validatePostgresOrderDiscount`／`validatePostgresActiveStoreDiscountPricing`／`validateOrderItemsForActivityDiscount` 的完整內容，全部只做「固定金額折扣會不會讓價格變負」這個舊制專屬的價格下限檢查，沒有任何權限、歸屬或注入相關邏輯；實際授權檢查（`store_access_denied`、`order_access_denied`、角色檢查）都在完全沒被這次改動觸碰到的另一段程式碼裡，維持原樣。
- **新制數學上不可能讓價格變負**：新的 `calculatePercentageDiscount(originalAmount, discountPercent)` 在 `discountPercent` 限制在 1-99、`originalAmount >= 0` 的前提下，`ceil(originalAmount * (100-percent)/100)` 保證落在 `[0, originalAmount]` 之間；輸入超出範圍會直接 `throw`（fail closed），不是靜默轉型，所以拿掉舊檢查是拿掉多餘的重複邏輯，不是拿掉真正的防護。
- **`discount_percent` 範圍在每一條寫入路徑都有後端驗證，不只是前端**：`validateDiscountTierConfiguration`（PostgreSQL 與 SQLite 活動建立路徑共用）拒絕非整數或超出 1-99 的值；`database/schema.sql` 與 migration 008 在 `promotion_tiers`／`activity_settlements` 都加了對應的 CHECK constraint；`completePostgresSettlement` 在寫入結算快照前另外做了一次 `discountPercentValid` 檢查。Mobile 端「打幾折」輸入（`discountPercentFormat.js`）純粹是顯示/輸入層轉換，換算出來的值一樣要通過上述所有後端檢查。
- **SQL 一律使用參數化查詢**：這次改動到的所有 repository 查詢（含新 migration）都用 `$1`／`$2`／`ANY($n::text[])` 參數化，沒有字串拼接組出來的 SQL。
- 附帶檢查了同一批 `git diff` 裡出現、但**不是這次任務範圍**的 `backend/database/repositories/adminStatisticsRepository.js`（新檔案）與 `server.js` 的 `/admin/statistics` 路由——這是另一位協作者（Codex）同時在處理的東西，本次任務沒有修改也沒有依賴它；順帶確認它沿用既有的 `requireAdminWebUser` 授權檢查、輸出經過 `escapeHtml()`，沒有明顯問題，但正式驗收應由該項改動自己的作者或另一次 review 負責，不算在本次記錄的審查範圍內。
- `npm test` 146/146 全過；另外用本機真實 PostgreSQL 走過一次乾淨的單一結算情境（活動打 7.9 折、訂單原價 $65），確認 `orders.final_amount`／`payment_captures.capture_amount` 正確寫入 $52（`ceil(65*0.79)`），LINE Pay（mock provider）沒有多扣或少扣。尚未針對 Azure 展示環境做遷移驗證（需要使用者自行清空 `group_buy_activities` 後才能套用 migration 008，已在對話中提醒）。

## 2026-09-22 — 顧客端 UI 全面換皮（奶茶上色第二批：付款、我的訂單等 10 個畫面）

**範圍**：`docs/ui-style-guide.md` 第一批之後的第二批，10 個顧客畫面全部換成奶茶樣式：`StoreGroupBuyActivitiesScreen.jsx`、`GroupBuyActivityDetailScreen.jsx`、`GroupProgressScreen.jsx`、`StoreMenuScreen.jsx`、`DrinkSelectionScreen.jsx`、`CartScreen.jsx`、**`PaymentAuthorizationScreen.jsx`**、**`CustomerOrdersScreen.jsx`**、`ProfileScreen.jsx`、`LiveMapScreen.web.jsx`／`LiveMapScreen.native.jsx`／`ActivityFilterPanel.jsx`；新增多個共用元件（`Card`／`Notice`／`ChoiceChip`／`CheckRow`／`QuantityStepper`／`EmptyPanel`／`ValueRow`／`PearlTray`／`TierLadder`）與分頁切換滑動動畫（`ScreenTransition.jsx`）；另外新增一支獨立唯讀診斷腳本 `scripts/preview-clear-activities.js`（清空展示資料前先看會刪掉多少筆，全程 `BEGIN READ ONLY` 後 `ROLLBACK`，不接觸 Azure）。
**觸發原因**：付款預授權（`PaymentAuthorizationScreen.jsx`）與我的訂單（`CustomerOrdersScreen.jsx`）是付款相關畫面，依專案規則換皮完成後主動跑一次 `/security-review`；同一批一併記錄。

### 方法

- 10 個畫面分別由獨立的「實作 → 審查 → 修正」三階段 subagent 處理，審查階段對照 `git diff HEAD -w` 逐個 hunk 分類（樣式值／JSX 結構／樣式限定 prop／文案／`handler`／`condition`／`effect`／資料流），任何非前三類的差異一律視為需要修正或說明的發現。付款相關的兩個畫面額外要求「逐行列出每一個非樣式值的改動、並說明為什麼不會影響行為」。
- 我自己針對付款相關的改動另外做了一次獨立複查（不只是信任 subagent 的自述）：直接讀 `git diff HEAD -w` 確認每一處被移除的 `onPress`／`disabled`／金額運算式都能在新版找到逐字相同的對應（只是從 `onPress` 換成共用元件的 `onDecrease`／`onIncrease`／`onToggle`），並用渲染截圖實際驗證修正後的畫面。
- 用 `/security-review` 對整條分支的完整 diff（含本批全部 10 個畫面、新共用元件、新診斷腳本）做一次注入／權限／機密／資料外洩掃描。
- `npm test`、`npm run check:sql-safety`、Android 目標 Babel 編譯（45 個 mobile 檔案）全部重新跑過，確認最終狀態。

### 發現

`/security-review` 沒有找到信心度達到門檻（0.7 以上）的漏洞。

有一個**流程上的插曲**，記錄下來但不是安全漏洞：兩輪獨立審查對「這是不是邏輯改動」的認定不一致。第一輪審查認為付款畫面新增的 `showLinePaySection`（LINE Pay 區塊在授權/請款後且沒有任何訊息時不顯示空標題）與 `getSyncNoticeTone`（同步狀態的顏色依 `order?.paymentStatus` 決定，而不是「非錯誤一律綠色勾勾」）屬於「純呈現」；第二輪審查認定這兩者都新增了條件式／資料依賴，屬於邏輯改動，依規則「發現邏輯改動一律還原、不得自行判斷」把兩者都刪掉了，現在的程式碼對 `PaymentAuthorizationScreen.jsx` 是**跟 HEAD 零邏輯差異**（已用 `grep` 確認 `showLinePaySection`／`getSyncNoticeTone` 兩個識別字都不存在）。同一批「我的訂單」的取消訂單提示改成依成功/失敗顯示不同顏色，因為是在已知的 `try`／`catch` 分支「當下」直接指定顏色（不是另外讀取別的欄位），沒有被判定為邏輯改動，予以保留——已用 `git diff` 確認 `setCancelNotice({ tone: "success" })`／`{ tone: "danger" }` 分別寫在對應分支裡。

### 沒發現問題的部分

- **付款畫面最終是零邏輯差異**：`git diff HEAD -w -- mobile/src/screens/PaymentAuthorizationScreen.jsx` 只剩樣式值替換、共用元件包裝（`Card`／`Notice`／`ValueRow`／`CheckRow`）與兩處圖示文字符號改成用 View 畫出來；`disabled` 運算式、`onPress` 呼叫、`startPayment`／dev-capture 的守門條件、金額運算式（`formatCurrency`、`payment.originalAmount`／`authorizedAmount`／`captureAmount`）逐字未變。
- **我的訂單的可動邏輯改動只有一處**（取消提示的顏色分流），且只讀取已經在同一個 `try`／`catch` 分支裡確定的成功/失敗結果，不涉及任何新的資料來源、權限或金額。
- **診斷腳本 `scripts/preview-clear-activities.js`**：只用一條靜態、參數化的 SQL（`format('SELECT count(*) AS c FROM %I.%I', ...)` 走 `query_to_xml`，表名來自 `pg_constraint`／`pg_class` 系統目錄查詢結果，不是外部輸入拼接），全程包在 `BEGIN READ ONLY` 交易並在 `finally` 一律 `ROLLBACK`；不印出連線字串、帳號或密碼，只印主機名稱與資料庫名稱；`npm run check:sql-safety` 通過。
- **無新增套件、無新增後端路由、無新增資料寫入路徑**：這批全部是 Mobile 端 UI 改動加一支唯讀腳本。

### 待人工決定（不是漏洞，是產品/UX 取捨）

以下兩項是第二輪審查基於「這批只做外觀，任何條件式改動一律還原」的嚴格標準而還原掉的改善，我認為原本的修法是安全的（已驗證過），但因為超出「純外觀」的授權範圍，沒有自行恢復：

1. **付款同步狀態顏色**：目前「已授權未扣款」與「已扣款」的同步訊息都顯示同一種綠色打勾（沿用既有行為），沒有依實際狀態分色。如果要修，做法要跟「我的訂單」的取消提示一樣——在呼叫端直接指定顏色，不要另外抽一個讀取 `order?.paymentStatus` 的獨立函式。
2. **團購詳情的級距階梯**：目前不會標示「目前在哪一級」，只是靜態清單；「團購進度」畫面的階梯有標示。

若要處理，建議另開一個小改動、走一次獨立的 `/code-review`，不要跟這次的外觀換皮綁在一起。

**驗證限制**：`npm test` 174/174、`check:sql-safety`、Android 目標 Babel 編譯（45 個檔案）全過；驗證都是網頁模擬環境（react-native-web）截圖比對，**沒有在 Android 真機或模擬器上操作過**，TalkBack、系統字體放大、真實手勢與觸控回饋都還沒有實機確認。`preview-clear-activities.js` 只在本機資料庫測試過，沒有對 Azure 執行。

---

## 2026-09-23 — 導覽架構改用 react-navigation（含 selectRole/logout/goToRoleSelect session 邏輯重寫）

**範圍**：Mobile 導覽系統整個架構遷移，從手刻的 `stack` 陣列導覽器改用 `@react-navigation/native` + `bottom-tabs` + `native-stack` + `react-native-screens` + `react-native-gesture-handler`。刪除 `mobile/src/navigation/AppNavigator.js`／`ScreenTransition.jsx`／`slideTransition.js`；新增 `mobile/src/navigation/`（`RootNavigator.jsx`、`CustomerTabs.jsx`、`MerchantTabs.jsx`、`linking.js`、`screens.js`、`stackOptions.js`、`withAppState.jsx`、`tabSlideInterpolator.js`、`stacks/` 六個 stack 定義）與 `mobile/src/state/`（`AppStateContext.js`、`AppStateProvider.jsx`、`stateHelpers.js`，把原本 `AppNavigator.js` 裡的全部業務邏輯──`actions`、8 個輔助函式、3 個主要 effect──逐字搬過去）；全站 19 個路由、約 54 個導覽呼叫點逐一改用 `push`／`navigate`／`goBack`。另外把 `mobile/src/screens/CustomerOrdersScreen.jsx`、`MerchantDashboardScreen.jsx` 的訂單明細從畫面內部 local state 改成真正的 stack entry（同路由 `push` 第二次＋`orderId` 參數），並在 `LiveMapScreen.native.jsx`／`.web.jsx` 加上 `useFocusEffect` 讓地圖分頁失焦時暫停 GPS 定位。
**觸發原因**：這次改動碰到 auth 相關的 session／角色切換邏輯（`selectRole`／`logout`／`goToRoleSelect` 整個重寫），以及全部金流相關畫面（`PaymentAuthorizationScreen.jsx`、`CartScreen.jsx`、`CustomerOrdersScreen.jsx`、訂單修改）的導覽呼叫點，依規則主動觸發，不等使用者提醒。

### 方法

- 先用一個 Explore agent 完整盤點舊系統的呼叫圖、參數形狀與既有怪癖，才開始動手（對應「重大決策先提出影響，不直接改」）。
- 業務邏輯搬移用程式逐字比對（Node 腳本 diff 舊 `AppNavigator.js` 與新檔案，只忽略 CRLF/LF），確認 `actions` 物件、8 個輔助函式、3 個 effect 零邏輯差異。
- 完成後自己起本機後端＋`react-native-web` 預覽，實際走過顧客（登入→四個分頁互切＋跨分頁導覽→加入團購→選飲料→購物車→LINE Pay 預授權→訂單成立→點進訂單明細再返回確認正確彈回列表）與商家（登入→建立活動的兩種入口皆可正確返回→登出）完整流程，確認主控台沒有新的導覽相關錯誤。
- `/security-review` 用獨立 subagent 對完整 diff＋全部新檔案做一次注入／權限／機密／資料外洩掃描，並要求對照舊版 `AppNavigator.js`（`git show HEAD:...`）比對歷史行為，只抓「這次改動新引入」的問題。

### 發現

`/security-review` 沒有找到信心度達到門檻（8/10 以上）的漏洞。

過程中我自己（不是 `/security-review` 抓到的，是實測時發現的）找到並修好一個**這次遷移本身造成的真 bug**，記錄如下因為它碰到 session／角色狀態機：
`selectRole`／`logout`／`goToRoleSelect` 原本沿用舊行為，直接呼叫 `navigationRef.current?.reset({ routes: [{ name: ... }] })` 重置導覽狀態。但新架構的根導覽器（`RootNavigator.jsx`）是「登入前畫面組／`CustomerTabs`／`MerchantTabs`」三選一互斥的條件式渲染，`reset()` 目標路由如果不在「當下實際掛載」的那一組畫面裡就一定會失敗（主控台跳出 `The action 'RESET' ... was not handled by any navigator`）。`selectRole`／`logout` 因為同時會改變 `currentRole`（觸發條件式渲染自然切到正確畫面組），即使 `reset()` 失敗也「意外正確」；但 `goToRoleSelect()`（會員頁「重新登入」按鈕背後的邏輯）刻意不改變 `currentRole`，沒有這個意外救援機制，等於呼叫了沒有任何畫面反應——會員頁的「重新登入」按鈕點了會完全沒反應。修法：新增一個 `showingRoleSelect` 狀態旗標，改由 `RootNavigator.jsx` 的同一組條件式渲染判斷（`!currentRole || showingRoleSelect`）決定要不要顯示角色選擇畫面，`navigationRef` 的 `reset()` 呼叫全部移除（改為 render-driven，不再需要 imperative reset）。這不是新增的信任決策或權限判斷，純粹是把「哪個畫面組要掛載」的判斷從一個結構上注定會失敗的 imperative API 呼叫，改成跟其他兩個分支同一套已經在用、已驗證正確的 state-driven 判斷。已在瀏覽器預覽中重新測過 `goToRoleSelect` 的實際呼叫路徑，確認主控台不再報錯、畫面正確切換。

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| Session／角色狀態機 | `logout()` 仍會清 bearer token、Firebase session、本機快取的訂單／購物車／付款紀錄；`goToRoleSelect()` 刻意保留 session（沿用舊版 `navigation.replace("roleSelect")` 的既有行為，不是新引入的例外） |
| 顧客／商家路由隔離 | `CustomerTabs.jsx`／`MerchantTabs.jsx` 註冊互斥的路由集合，`RootNavigator.jsx` 依 `currentRole` 只掛載其中一組；`showingRoleSelect` 為真時是完整卸載（條件式渲染整個替換，不是疊加），不會有商家或顧客畫面殘留在角色選擇畫面底下 |
| 訂單明細 `route.params.orderId` 新查詢路徑 | `CustomerOrdersScreen.jsx`／`MerchantDashboardScreen.jsx` 都只在已經依 `selectedCustomerId`／商家 `storeId` 篩選過的本機陣列裡查 `orderId`，沒有放寬到可以查到別人的訂單；這個陣列本身只來自已經是使用者身分範圍內的後端呼叫 |
| `DrinkSelectionScreen.jsx` 的 `editOrderId` 參數（取代原本的 `onSaveOrderItem` 閉包） | 只能透過內部 `navigation.push`（不是 deep link）到達，呼叫端已經是限定在目前顧客自己訂單範圍內的清單 |
| Deep link（`linking.js`） | `parseLinePayResultDeepLink` 逐字沿用舊版；`NavigationContainer` 沒有設定 `linking` prop，所以 react-navigation 自己的 URL-to-route 機制沒有啟用，唯一能被外部 URL 觸發的仍然只有這一條手動解析的 `drinkgroupbuy://payment/result?orderId=...`，跟遷移前一樣 |
| 機密／Log | 新增／改動檔案沒有新的 `console.log`、沒有新的 token／機密處理邏輯 |
| 危險 API | 沒有引入 `dangerouslySetInnerHTML`／`eval`／動態 `innerHTML` |

**這次沒審查到的部分**：後端完全沒有改動，這次範圍只有 Mobile 端導覽層。

### 待處理（不是漏洞，此次刻意不動）

實測時在 `CustomerOrdersScreen.jsx` 的訂單明細品項列發現一個**跟這次遷移無關的既有問題**：品項列本身是一個 `Pressable`（點擊進編輯），裡面又包了一個獨立的刪除按鈕 `Pressable`，在 `react-native-web` 上會渲染成 `<button>` 巢狀 `<button>`，主控台跳出 DOM 巢狀警告（`git diff` 確認這段 JSX 結構本次沒有被改到，純粹是既有寫法）。不影響功能（刪除按鈕有 `event.stopPropagation()`），只是網頁預覽的 DOM 合法性警告，原生手機不受影響。已另開背景任務追蹤，這次沒有動它。

### 事後補記：同日 `/code-review`（high）後的修正

`/code-review` 抓到一個跟金流路徑有關的退步，已修並記在這裡：LINE Pay 付款結果深層連結（`drinkgroupbuy://payment/result?orderId=...`）的「同一個網址只處理一次」防重複（舊版 `handledDeepLinkRef`）在遷移時被我漏掉，而處理函式又依賴每次購物車／訂單變動都會換身分的 `actions`，Android 上 `getInitialURL()` 會一直回傳啟動網址，等於每次狀態變動都可能重新導向付款畫面並重打後端。修法（`RootNavigator.jsx`）：恢復 `handledDeepLinkRef` 去重、`actions` 改從 ref 讀取且訂閱只做一次，並新增「暫存待處理連結」——導覽器尚未就緒或尚未登入成顧客時先存起來，`CustomerTabs` 掛載後才導向（原本冷啟動時會被靜默丟掉）。這不改變任何金額、權限或後端呼叫，只是讓同一個連結不會重複觸發 `syncOrderFromBackend` 與導覽。其餘修正（`OrdersStack` 補註冊 `groupProgress`、建立活動導覽與表單重置、首頁分頁 GPS 隨焦點暫停、點目前分頁回根畫面、`replace` 改 `goBack`、訂單輪詢隨焦點暫停、載入圈改用主題色）都是導覽／效能層，沒有碰付款或授權邏輯。**深層連結的冷啟動暫存路徑只做了程式碼審視，沒有在預覽裡實測**（網頁預覽的網址不是 `drinkgroupbuy://`，無法觸發）。

**驗證限制**：`npm test` 170/170、Babel 目標編譯全站 99 個檔案全過；驗證是本機 `react-native-web` 預覽＋本機後端手動走過完整購買與建立活動流程，**沒有在 Android 真機或模擬器上操作過**，兩個修掉的返回鍵 bug 只驗證了 react-navigation 內部的 stack pop 機制（透過畫面內「返回」按鈕），無法在網頁預覽驗證真正的 Android 實體返回鍵行為。

---

## 2026-09-25 — 顧客個人中心「省錢統計」新 API（`GET /api/customers/me/savings`）

**範圍**：`backend/database/repositories/customerSavingsRepository.js`（新）、`backend/server.js` 的新路由與 repository 建立（只看這幾段，同一檔案的 `/admin/statistics` 是另一條工作線的既有改動，不在範圍）、`mobile/src/utils/apiClient.js` 的 `getCustomerSavings`、`mobile/src/utils/customerSavings.js`、`mobile/src/screens/ProfileScreen.jsx` 的省錢統計區塊、`scripts/customer-savings-postgres-smoke.js`
**觸發原因**：CLAUDE.md 規則自動觸發——新增一支讀取金流衍生資料（訂單原價／請款金額）的已驗證 API。這次沒有改動任何付款、請款、退款、結算的寫入邏輯，也沒有資料庫結構變更
**方法**：兩層。(1) 內建 `/security-review` 流程：一個唯讀子任務只看上述檔案，追過完整呼叫路徑（含 `getAuthenticatedUser` → `verifyAuthToken` → `authProfileReadRepository.getById`，並與旁邊的 `GET /api/customers/me/orders` 逐行對照）；因為工作目錄還有另一條工作線的大量無關畫面改動，所以刻意限縮範圍，沒有把整個工作目錄的 diff 丟進去審。(2) 5 個角度的獨立審查（金額語意、安全與授權、手機端、測試與規範、整合與啟動），每個發現由 3 位審查員各自嘗試推翻，至少 2 位認為成立才保留

### 發現

`/security-review` 沒有找到信心度達到門檻（8/10 以上）的漏洞。5 角度審查裡的安全與授權角度同樣沒有發現。

5 角度審查另外留下 4 個**非資安**的低嚴重度問題，已全部修正並重跑驗證，記在這裡因為第 1 項牽涉「金額算得對不對」：

| 嚴重度 | 位置 | 問題 | 修法 | 狀態 |
|--------|------|------|------|------|
| 低 | `customerSavingsRepository.js` 的 SQL | 沒看團購活動狀態：管理員取消已結算的活動時，取消流程會刻意略過已請款訂單（`merchantGroupBuyActivityCancelRepository.js`），這類訂單永遠停在 `captured` 卻再也領不到飲料，仍被算進省下金額 | SQL 加 `JOIN group_buy_activities` 並要求 `activity.status <> 'cancelled'`；smoke 新增這種情境 | 已修 |
| 低 | `ProfileScreen.jsx` 說明文字 | 寫「已退款不列入」，但只有全額退款不計、部分退款仍計入 | 改成「已全額退款、逾期未取或團購被取消的不列入」 | 已修 |
| 低 | `ProfileScreen.jsx` | 內文與說明文字套用了 `maxFontSizeMultiplier`，違反 `docs/ui-style-guide.md` 第 6 條（只限取餐碼、珍珠數字、標籤） | 只保留在標籤與金額數字 | 已修 |
| 低 | `customerSavingsRepository.test.js` | `status <> 'cancelled'` 斷言沒有錨定，`pickup_status <> 'cancelled'` 也會通過 | 每條斷言都加上 `AND orders.` 前綴；改壞任一條件都會讓測試失敗（已做過兩種故意弄壞的反向驗證） | 已修 |

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| 身分與授權 | 路由不讀路徑參數、query、body 來決定顧客身分，唯一傳進查詢的是 `authUser.id`（來自驗證過的 bearer token）。`verifyAuthToken` 先用 HMAC 簽章（`timingSafeEqual`）驗證再解析，並檢查過期；使用者與角色每次請求都從資料庫重新讀取（`users.status = 'active'`、有效的 `user_roles`），不信任 token 內的角色宣告，停用帳號或撤銷角色會立即失效 |
| 越權讀取他人資料 | 實測：顧客 A 的 token 帶 `?customerUserId=`／`?customer_user_id=` 指向顧客 B，回傳的仍是 A 自己的數字；smoke 也驗證「A 的訂單變動不影響 B 的總額」 |
| 角色邊界 | 實測：沒 token 401、亂填 token 401、商家 token 403、POST 回 404；跟 `GET /api/customers/me/orders` 的守門順序逐行相同 |
| SQL 注入 | 唯一變數 `customerUserId` 用 `$1` 綁定，其餘全是常數；單元測試用含注入字串的 id 驗證沒有被插進 SQL |
| 資料外洩 | 回應只有三個整數（總省下金額、訂單數、杯數），沒有訂單 ID、店家、其他使用者資料；沒有新增任何 log |
| 路由遮蔽 | 前面沒有任何路由或前置處理會先攔到這個路徑；`isSqliteOrderDependentRoute` 不會匹配 |
| 手機端 | 固定網址無使用者輸入；token 走 `Authorization` 標頭；數值以 `<Text>` 子節點顯示，沒有 HTML sink；`normalizeCustomerSavings` 只接受非負整數，其餘一律當作載入失敗；登出時整個顧客畫面樹會卸載，同一台裝置換下一位登入看不到前一位的數字 |
| smoke 腳本 | 只新增與刪除自己帶 UUID 後綴的資料列，全部參數綁定 |

**這次沒審查到／沒驗證到的部分**：Android 實機沒有操作過，只用本機後端搭配 `react-native-web` 網頁預覽看過有數字、空狀態、錯誤與重試四種畫面。深色模式沒有另外截圖。

### 過程中的事（不是漏洞，記錄以免重犯）

用來實機驗證的本機後端沒有關掉自動結算排程，把驗證用的假活動（截止時間在過去）結算掉，導致假資料一度清不掉。只影響自己塞的假資料（本機資料庫原本的 4 場活動在 9/23、9/24 就已結算，今天沒有被動到），已徹底清除。之後：驗證用的後端一律先關排程；`scripts/customer-savings-postgres-smoke.js` 的假活動截止時間改在未來，排程掃不到。

---

## 2026-09-25 — 展示用假資料產生器（`scripts/seed-demo-data.js`）

**範圍**：`scripts/seed-demo-data.js`、`scripts/helpers/demoDataBuilder.js`（新）。這是開發者手動執行的指令列工具，不屬於伺服器程式，沒有改動任何付款、請款、退款、結算的邏輯；但它會把假的付款、請款、退款紀錄與假帳號寫進資料庫，而且可以指向共用的 Azure 展示資料庫，所以照金流相關規則審查
**觸發原因**：CLAUDE.md 規則（會寫入付款資料表、會建立帳號、具備遠端寫入能力）
**方法**：一個獨立的唯讀子任務只看這兩支檔案，並追進它們碰到的後端程式（登入、註冊、三種排程的挑選條件、退款供應商解析）；另外我自己實測了各種保護機制。這次沒有用內建 `/security-review` 指令整包審查，因為工作目錄還混著另一條工作線大量無關的未提交畫面修改，整包審查會被那些改動淹沒

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。審查員提出兩項低風險觀察：

| 嚴重度 | 位置 | 問題 | 處理 | 狀態 |
|--------|------|------|------|------|
| 低 | `seed-demo-data.js` 的 `describeTarget` | 連線網址若帶 `?host=` 或 `?hostaddr=`，pg 會改連那個主機，「是不是本機」的判斷會被繞過 | 帶有這兩個參數的網址一律視為遠端（需要 `--allow-remote`）；已實測 | 已修 |
| 低（資料完整性，非資安） | 假團購掛在真實店家底下 | 會算進真實店家的統計與營收排行 | 展示用途的預期行為，已寫進 `docs/azure-classroom-deployment.md` 的已知限制；移除示範資料即恢復 | 評估後不修（預期行為） |

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| SQL 注入與識別字組裝 | 所有串進 SQL 的資料表與欄位名稱都來自常數清單（`TABLES`）或先過 `/^[a-z_]+$/` 檢查；所有值都是參數綁定（`$n`）。指令列輸入（`--focus-email`、`--focus-user-id`）只會以參數形式進入資料庫，數字選項必須是整數 |
| 清除範圍 | 只依 `demo-seed-` 前綴（不含萬用字元）刪除，逆著外鍵順序、單一交易；真實使用者與訂單的 ID 是 `user-<uuid>`／`order-<uuid>`，不可能符合；重點顧客（真實帳號）本身的帳號、角色、個人資料不會被動到，只會移除他名下帶前綴的示範訂單。實測：清除前後原有的 4 場活動、2 筆訂單、12 個帳號完全不變 |
| 假帳號能否被拿來登入 | `firebase_uid`、`login_name`、`password_hash` 都是空的；正式登入只認驗證過的 Firebase 憑證對應的 `firebase_uid`，對不上；信箱網域 `@example.test` 是保留網域，真實 Google 帳號不可能註冊；若真有人用相同信箱註冊，會被唯一鍵擋下（`email_already_registered`，不會合併或接管）；只有 `AUTH_DEV_MODE` 開啟時的開發登入端點能以這些帳號登入，那個開關開著時本來就能扮演任何使用者，沒有新增能力，關閉時完全不可達 |
| 商家權限 | 假商家帳號有 merchant 角色但沒有 `merchant_users` 資料列，商家權限只由後者決定，所以沒有任何真實門市的存取權 |
| 真實付款程式會不會處理這些假紀錄 | 結算排程只挑招募中／已成團／進行中的活動，假活動都是已完成／失敗／取消；取貨逾期排程只挑進行中／可取貨的活動，同樣不會選到；付款對帳排程只挑「真實 LINE Pay、狀態待處理」的授權，假紀錄是 `mock_line_pay` 且已請款／已作廢；腳本不寫入任何排程工作紀錄；`mock_line_pay` 的退款只在非 production 環境被接受，而且不會呼叫外部 API，不會有真的錢移動 |
| 遠端寫入保護 | 用 `new URL().hostname` 解析，帳號密碼段（`user@host`）會被去掉、主機名稱轉小寫、IPv6 正確辨識；`localhost.`（結尾多一個點）與空主機（unix socket 網址）都被當成遠端而擋下（失敗方向是安全的）；判斷與實際連線用同一個 `DATABASE_URL` 字串；已實測：遠端網址不加 `--allow-remote` 會在連線前就拒絕 |
| 機密外洩 | 只印主機名稱、資料庫名稱與「本機／遠端」；網址格式錯誤時只丟出 `Invalid URL`，不會把密碼印出來 |
| 資料寫入的原子性與重複執行 | 整批寫入是單一交易，失敗即整批復原；先檢查 migration 008 已套用；已有示範資料時拒絕重複寫入；不加 `--apply` 一律只預覽 |

**這次沒審查到／沒驗證到的部分**：實際寫進 Azure 資料庫沒有做（由使用者自己執行）；產生器裡的取貨碼用可預測的偽隨機數，但它們只屬於已核銷或已過期的示範憑證，沒有利用價值。

---

## 2026-09-26 — 商家營運統計 API（`GET /api/merchant/stores/:storeId/statistics`）

**範圍**：`backend/database/repositories/merchantStatisticsRepository.js`（新）、`backend/server.js` 的新路由與 repository 建立（只看這幾段）、`mobile/src/utils/apiClient.js` 的 `getMerchantStoreStatistics`、`mobile/src/utils/merchantStatistics.js`、`mobile/src/screens/MerchantStatisticsScreen.jsx` 與導覽註冊、`scripts/merchant-statistics-postgres-smoke.js`
**觸發原因**：CLAUDE.md 規則自動觸發——新增一支讀取營收、請款、退款金額的已驗證 API，而且有「一家店不能看到別家店」的租戶邊界。這次沒有改動任何付款、請款、退款、結算的寫入邏輯，也沒有資料庫結構變更
**方法**：兩層。(1) 一個獨立的唯讀子任務，重點查租戶隔離與授權、金額算法（含資料列重複相乘、多筆退款、各種結算結果）、手機端、測試品質，並追進 `getUserFromToken`、`authProfileReadRepository`、`canManageStore`、退款與結算寫入程式；這次沒有用內建 `/security-review` 指令整包審查，因為工作目錄還混著另一條工作線大量無關的未提交畫面修改。(2) 我自己的實測：真實 HTTP 授權測試，以及用另一套算法從原始資料重算 store-001 的數字，與 API 逐項核對

### 發現

沒有找到信心度達到門檻（7/10 以上）的漏洞，也沒有找到在真實資料下會算錯的數字。審查員提出四項低風險觀察：

| 嚴重度 | 位置 | 問題 | 處理 | 狀態 |
|--------|------|------|------|------|
| 低 | smoke 腳本 | 沒有涵蓋「一筆訂單有多筆退款」（彙總時可能重複計算）、「待處理或失敗的退款不能被扣」；有人拿掉子查詢的 `GROUP BY` 或 `status = 'refunded'` 條件，測試不會失敗 | 新增一筆有四筆退款（兩筆完成、一筆待處理、一筆失敗）的訂單，並重新做故意弄壞驗證，兩種弄壞都會讓測試失敗 | 已修 |
| 低 | `merchantStatisticsRepository.js` 成團率查詢 | 「已結算、事後被管理員取消」的團購仍算進成團率，但同一批訂單的營收不計，兩個數字的活動範圍不一致 | 成團率也排除被取消的團購；smoke 新增這種情境並驗證 | 已修 |
| 低 | `merchantStatistics.js` | 若資料異常導致退款大於實收，手機端會顯示錯誤畫面而不是負數 | 這是刻意的「寧可失敗也不顯示錯數字」 | 評估後不修（預期行為） |
| 低 | `MerchantStatisticsScreen.jsx` | 若畫面掛著時店家編號改變，新資料載入前會暫時顯示上一家的數字 | 目前一個商家登入只對應一家店，畫面掛著時編號不會改變；而且每次請求後端都會重新授權，顯示的也是同一位使用者自己的另一家店，不是別人的資料 | 評估後不修（目前不會發生） |

### 沒發現問題的部分（已交叉驗證）

| 面向 | 檢查結果 |
|------|----------|
| 租戶隔離 | 三條查詢全部以 `activity.store_id = $1` 過濾（`order_items`、退款子查詢、結算查詢都是經由已過濾店家的訂單或活動連到的），店家編號一律是綁定參數；網址片段全程不解碼，「授權檢查用的值」與「送進 SQL 的值」是同一個字串，不存在檢查與使用不一致；`%xx` 編碼、大小寫不同、前後空白的編號都過不了授權 |
| 授權 | `merchantStores` 只來自狀態為 active 的 `merchant_users` 列，角色只來自 active 的 `user_roles`，而且每次請求都從資料庫重新讀取，不信任 token 內的內容，停用或撤銷會立即失效。實測：沒 token 401、亂填 token 401、顧客 token 403、管理員 token 403（跟同層的訂單列表路由一致，只給商家）、商家看別家店 403、不存在的店 403、店家編號帶注入字串 403、POST 404、看自己的店 200 |
| 金額算法 | 退款子查詢先 `GROUP BY order_id` 並只取 `status = 'refunded'`，所以一筆訂單有多筆退款也不會讓訂單被重複計算（smoke 有實例驗證），待處理與失敗的退款不會被扣；全額退款的訂單狀態會變成 `refunded` 而被排除，部分退款則從實收扣除，沒有重複扣；訂單彙總查詢沒有連到品項表，所以筆數與金額不會被放大；結算 `outcome = 'cancelled'` 不會被計入成團或未成團；沒有結算紀錄的活動，其已請款訂單仍計入營收（營收不依賴結算）。真實資料交叉驗證：store-001 的 API 結果與獨立重算完全一致 |
| 資料外洩 | 回應只有七個彙總欄位，熱賣飲品只有品名與杯數，沒有顧客或訂單識別資訊；沒有新增任何 log |
| 路由遮蔽 | 前面沒有任何路由或前置處理會攔到這個路徑，`isSqliteOrderDependentRoute` 不會匹配 |
| 手機端 | 所有 hook 都在提早 return 之前執行；用 `active` 旗標避免舊回應蓋掉新狀態；店家編號來自 `selectedMerchantStoreId`，後端仍會用 token 重新驗證；`normalizeMerchantStatistics` 會擋下非整數、負數、成團數大於已結算數、比例超出 0～1、品名為空、杯數非正數；沒有寫死的顏色；數值以 `<Text>` 子節點顯示，沒有 HTML sink |
| smoke 腳本 | 建立三家暫時店家（狀態為 `closed`，不會出現在任何 App 畫面），只新增與刪除自己帶 UUID 後綴的資料列，全部參數綁定；假活動截止時間在未來，排程不會碰；清除後殘留 0 列。八種故意弄壞驗證（拿掉活動取消、訂單取消、店家過濾、退款扣除、多筆退款彙總、退款狀態過濾等條件）全部會讓測試失敗 |

**這次沒審查到／沒驗證到的部分**：Android 實機沒有操作過，只用本機後端搭配 `react-native-web` 網頁預覽看過有數字、錯誤與重試畫面；深色模式沒有另外截圖。

---

## 2026-09-27 — 推送前最終複查（省錢統計／商家統計／匯入確認框修正／示範資料產生器）

**範圍**：`backend/database/repositories/customerSavingsRepository.js`、`merchantStatisticsRepository.js`、`backend/server.js` 的 `GET /api/customers/me/savings`、`GET /api/merchant/stores/:storeId/statistics` 兩條路由、管理員匯入菜單頁面的確認框修正（`renderAdminMenuImportBody`）、`scripts/seed-demo-data.js`／`scripts/helpers/demoDataBuilder.js`
**觸發原因**：CLAUDE.md 規則——這批改動要 commit 並 push，其中省錢統計、商家統計、示範資料產生器都屬於金流相關工作。省錢統計與示範資料產生器呼應 2026-09-25 那兩筆記錄、商家統計呼應 2026-09-26 那筆記錄，這三塊程式碼自上次記錄後沒有再變動，這次是確認沒有回歸，不是重新發現問題；唯一真正新的變動是匯入菜單頁面的確認框修正
**方法**：一個獨立的唯讀子任務重新檢查上述範圍（含比對 `canManageStore` 授權模式是否跟既有的 `/orders`、`/refund-requests` 路由一致），這次工作目錄裡混著另一條「深色模式換色系」工作線的大量 UI 改動，子任務已被明確告知排除，只看後端與這幾支腳本

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| — | — | 這次沒有新發現 | — | — |

### 沒發現問題的部分（呼應先前記錄，確認未回歸）

| 面向 | 檢查結果 |
|------|----------|
| `customerSavingsRepository.js` | 單一參數化查詢（`$1` 綁 `customerUserId`），沒有字串拼接；狀態篩選條件都是寫死字面值，不受使用者輸入影響。與 2026-09-25 記錄一致 |
| `merchantStatisticsRepository.js` | 三條查詢全部參數化，`storeId` 只以綁定參數傳入，`SALES_ORDER_FILTER` 是不含使用者輸入的靜態片段。與 2026-09-26 記錄一致 |
| `GET /api/customers/me/savings` | 顧客編號完全來自已驗證 token（`authUser.id`），不接受 URL／query 覆寫，不存在 IDOR |
| `GET /api/merchant/stores/:storeId/statistics` | 驗證身份、要求 `merchant` 角色、呼叫 `canManageStore` 後才查詢，寫法與既有的 `/api/merchant/stores/:storeId/orders`、`/refund-requests` 路由完全一致，沒有偏離既有授權模式 |
| 匯入菜單確認框修正（`form="menu-import-form"`） | 純 UX 修正：讓原本沒有隨表單送出的勾選框改為透過 `form` 屬性關聯，使其能正確送出。這個勾選框本身不是身份驗證或授權關卡，只是「確認要取代現有菜單」的提示；CSRF token 仍在 `<form>` 內、POST handler 一開始仍會呼叫 `readCsrfVerifiedAdminFormBody` 驗證，不受這個修正影響 |
| `scripts/seed-demo-data.js`／`demoDataBuilder.js` | 遠端資料庫保護（含 `?host=`／`?hostaddr=` 的已知繞過）、`--allow-remote`／`--apply` 雙重開關、示範資料清除範圍、假帳號無法登入等，與 2026-09-25 記錄一致，程式碼自上次審查後未變動 |

**這次沒審查到／沒驗證到的部分**：跟上兩筆一樣，沒有在 Azure 上實測；這次也沒有另外審查深色模式那條工作線（UI 顯示邏輯，不屬於本次金流／授權範圍）。

---

## 2026-09-28 — 後台數據統計：訂單/營收趨勢與顧客活躍時段分析

**範圍**：`backend/database/repositories/adminStatisticsRepository.js` 新增的 `getWeeklyTrend()`／`getPeakHours()` 兩個唯讀查詢，`backend/server.js` 的 `/admin/statistics` 路由（呼叫這兩個新函式）與新增的 `renderBarChart()` 輔助函式、`renderAdminStatisticsBody` 新增的兩個區塊（長條圖／表格）
**觸發原因**：CLAUDE.md 規則自動觸發——新增會顯示營收、折扣金額的後台頁面內容，屬於金流相關的資料呈現（雖然是唯讀、沒有寫入邏輯）
**方法**：一個獨立的唯讀子任務，重點查（1）這兩個新查詢有沒有任何使用者輸入路徑（追到路由層確認呼叫時完全不帶參數）、（2）新的 HTML 區塊有沒有漏掉 `escapeHtml`、長條圖高度用的百分比數值有沒有可能跳脫 `style` 屬性、（3）`/admin/statistics` 路由是否還在既有的 `requireAdminWebUser` 之後才執行。這次沒有用內建 `/security-review` 整包審查，因為工作目錄裡還有這次任務本身以外、我這輪沒有處理的其他未提交檔案

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| — | — | 這次沒有新發現 | — | — |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| SQL 注入 | `getWeeklyTrend` 只綁定一個寫死常數（`WEEKLY_TREND_WEEKS = 8`）到 `$1::int`，`getPeakHours`完全不帶參數；兩者都沒有字串拼接 |
| 使用者輸入路徑 | 追到路由層確認這兩個函式呼叫時完全不帶任何來自 `request`／`url`（query string、body、header、session）的引數，攻擊面等於零 |
| 授權 | `/admin/statistics` 路由沿用既有的 `requireAdminWebUser` 檢查，跟檔案裡其他約 15 條 `/admin/*` 路由寫法一致，沒有新增繞過這個關卡的路徑 |
| XSS／HTML 跳脫 | `renderBarChart()` 的 `valueLabel`／`label` 都有 `escapeHtml`；`style="height:N%"` 的 `N` 是 `Math.round((item.value / maxValue) * 100)`，`item.value` 追到底只會是 Postgres `COUNT(*)` 轉出來的非負整數（`Number(row.order_count)`），不可能是 NaN／Infinity／字串，`Math.max(1, ...)` 保證分母不為 0，數學上不可能跳脫屬性；週別標籤 `formatAdminWeekLabel` 只對 SQL `to_char(..., 'YYYY-MM-DD')` 產出的固定格式字串做 `.slice()`，本身不可能含 HTML 特殊字元；金額欄位沿用既有的 `formatAdminCurrency`，跟原本的熱門店家表格同一套 |
| 資料外洩 | 兩個新區塊都是全站彙總（不分店家、不分顧客），沒有比既有的 `getBasicStatistics`／`topStores` 多揭露任何邊界內的資料 |

---

## 2026-09-28 — 後台：單一店家詳細統計頁面（`GET /admin/stores/:storeId/statistics`）

**範圍**：`backend/database/repositories/storeDirectoryReadRepository.js` 新增的 `getStoreById()`、`backend/database/repositories/merchantStatisticsRepository.js` 新增的 `getStoreWeeklyTrend()`、`backend/server.js` 新路由與 `renderAdminStoreStatisticsBody`，以及「熱門店家排行」表格把店名改成連到這個新頁面的連結
**觸發原因**：CLAUDE.md 規則自動觸發——新增一支會把單一店家的營收、折扣、趨勢資料顯示給管理員看的頁面，屬於金流相關的資料呈現
**方法**：一個獨立的唯讀子任務，重點查（1）`getStoreById`／`getStoreWeeklyTrend` 有沒有字串拼接、（2）新路由是否還在既有的 `requireAdminWebUser` 之後才執行、404 分支有沒有在查詢前就先擋掉、（3）店家 ID 在 URL 與連結之間的編碼/解碼有沒有不一致、（4）新 HTML 有沒有漏掉 `escapeHtml`（含 `href` 屬性裡只用 `encodeURIComponent` 沒有額外跳脫的情況）、（5）「管理員能看到任何一間店的營收」是不是跟既有後台頁面一致的預期行為，不是這次新引入的揭露範圍

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| — | — | 這次沒有新發現 | — | — |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| SQL 注入 | `getStoreById` 單一 `WHERE id = $1`；`getStoreWeeklyTrend` 的 `storeId` 綁 `$1`、`WEEKLY_TREND_WEEKS`（寫死常數）綁 `$2`，`SALES_ORDER_FILTER` 沿用既有 `getStoreStatistics` 已經在用的靜態字串，沒有新的拼接 |
| 授權 | 新路由跟檔案裡其他約 15 條 `/admin/*` 路由一樣，一開頭就呼叫 `requireAdminWebUser`；404 分支（店家不存在）在任何統計查詢之前就直接回傳，且 404 頁面是完全不回顯 `storeId` 的固定字串 |
| 路徑處理 | 新路由的 `:storeId` 擷取方式（`[^/]+`，不額外 decode）跟既有的 `/admin/stores/:storeId/import-menu` 完全一致；連結產生時用 `encodeURIComponent(store.id)`，跟檔案裡其他既有連結（退款申請 `request.id`、商家申請 `resultingStoreId`）同一套寫法，不是這次新引入的不一致 |
| XSS／HTML 跳脫 | `renderAdminStoreStatisticsBody` 裡的 `store.id`、狀態標籤、統計數字、熱賣飲品名稱全部有 `escapeHtml`；頁面標題經過 `renderAdminPage` 既有的跳脫處理。店名連結的 `href` 只用 `encodeURIComponent` 沒有另外 `escapeHtml`，但店家 ID 是伺服器自己產生的 slug（不是使用者輸入）、`href` 本身是固定格式路徑、`encodeURIComponent` 本身就會跳脫雙引號，三個條件疊加起來不構成漏洞，且是檔案裡既有的寫法，不是這次新增的風險 |
| 資料外洩 | 這個頁面讓管理員看到「任何一間店」的營收／折扣／趨勢，沒有依店家限制——但後台本來就沒有「只能管理特定店家」的管理員角色（`ADMIN_WEB_PASSWORDS` 是共用密碼），`renderAdminDashboardBody`、既有的「熱門店家排行」本來就已經是全店彙總視角，這只是把同一份既有可見資料做成可以點進去看細節，不是新的揭露範圍 |

**這次沒審查到／沒驗證到的部分**：沒有在 Azure 上實測。

---

## 2026-09-28 — 顧客回購／留存分析（後台）＋商家端補上趨勢長條圖

**範圍**：`backend/database/repositories/adminStatisticsRepository.js` 新增的 `getCustomerRetention()`（後台，全平台彙總）；`backend/server.js` 的 `/admin/statistics` 路由（呼叫這個新函式）與 `renderAdminStatisticsBody` 新增的回購率卡片／每週回頭客佔比折線圖；`GET /api/merchant/stores/:storeId/statistics` 路由改成同時回傳既有的 `merchantStatisticsRepository.getStoreWeeklyTrend()`（這個函式先前已存在、只是這次才第一次透過商家端路由曝露出去）；`mobile/src/utils/merchantStatistics.js` 的 `normalizeWeeklyTrend` 驗證與 `mobile/src/screens/MerchantStatisticsScreen.jsx` 的長條圖畫面
**觸發原因**：CLAUDE.md 規則自動觸發——顧客回購分析會彙總全平台顧客的下單行為，商家端趨勢圖會把既有的店家營收資料多曝露一個管道（雖然函式本身不是新的）
**方法**：一個獨立的唯讀子任務，重點查（1）兩條回購率查詢有沒有拼接、（2）`/admin/statistics` 是否還在 `requireAdminWebUser` 之後才執行、商家路由的 `canManageStore` 檢查是否還在新加的第二個查詢之前、（3）回購率查詢有沒有不小心把個別顧客 ID／Email／姓名帶進回傳結果（這是這次最重要的檢查項目，因為主題是「顧客資料彙總」）、（4）`getStoreWeeklyTrend` 透過商家路由曝露時，店家範圍限制是否跟同檔案其他查詢一致、（5）新的 HTML 區塊有沒有漏掉既有的跳脫慣例

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| — | — | 這次沒有新發現 | — | — |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| SQL 注入 | 兩條回購率查詢都沒有字串拼接——總體回購率那條完全不帶參數，每週回頭客那條只綁寫死常數 `WEEKLY_TREND_WEEKS`（值為 8）到 `$1::int` |
| 授權 | `/admin/statistics` 呼叫 `getCustomerRetention()` 前一樣先經過 `requireAdminWebUser`；商家統計路由的 `canManageStore` 檢查在呼叫（新增的）`Promise.all` 之前就先執行完，新加的第二個查詢沒有被誤放到授權檢查前面 |
| 資料外洩（本次審查重點） | 逐行讀過兩條回購率 SQL 與對應的 JS 組裝程式碼：`customer_user_id` 全程只用在 `GROUP BY`／`JOIN` 當 key，最終的 `SELECT` 清單跟回傳給前端的物件都只有 `COUNT(*)` 彙總出來的數字（總顧客數、回購顧客數、每週活躍/回頭客數與比例），完全沒有任何一個顧客的 ID、Email 或姓名離開資料庫查詢的範圍 |
| `getStoreWeeklyTrend` 透過商家路由曝露的範圍 | 這個函式沿用既有的 `SALES_ORDER_FILTER`（跟同檔案的 `getStoreStatistics` 共用同一個店家範圍界線），`storeId` 一樣是綁定參數，路由端傳進去的值就是已經通過 `canManageStore` 驗證過的那個店家 ID，沒有新的洩漏 |
| XSS／HTML 跳脫 | 回購率卡片的 label／value 走既有 `.map(...escapeHtml...)` 那條既有管線；每週回頭客折線圖只餵進 `Math.round()` 算出來的數字百分比跟既有的 `formatAdminWeekLabel`，跟上面已經審查過的「訂單與營收趨勢」折線圖同一套寫法，沒有新的未跳脫字串 |
| 手機端（次要） | `WeeklyTrendChart` 用 React Native `View`／`Text` 渲染，不是 HTML，沒有注入面；`normalizeWeeklyTrend` 會在資料格式不對時整包拒絕 |

**這次沒審查到／沒驗證到的部分**：沒有在 Azure 上實測（這次改動沒有牽涉 migration，之後推上去部署即可生效，不需要額外資料庫操作）。

## 2026-09-30 — 顧客端推播通知（開團成功、可以領飲料，新功能）

**範圍**：新增 `database/migrations/009_push_tokens_postgres.sql`、`backend/database/repositories/pushTokenRepository.js`、`backend/notifications/pushSender.js`；新路由 `POST /api/push-tokens`（`backend/server.js`）；兩個既有高風險流程新增的觸發點——`backend/payments/settlementService.js`（結算成團時）、`backend/pickup/credentialService.js` 與 `backend/database/repositories/pickupCredentialRepository.js`（標記可取餐時）；`backend/database/repositories/groupBuySettlementRepository.js` 的 `mapActivity()` 補回傳 `title` 欄位；mobile 端 `mobile/src/utils/pushNotifications.js`、`mobile/src/utils/apiClient.js` 的 `registerPushToken`、`mobile/src/state/AppStateProvider.jsx` 的登入 hook
**觸發原因**：CLAUDE.md 規則自動觸發——改動碰到 `settlementService.js`（結算）與取貨（`credentialService.js`）這兩個既有高風險流程，且新增一支會寫入資料庫、任何登入者皆可呼叫的公開 API（`POST /api/push-tokens`）
**方法**：一個獨立子任務先找漏洞，重點查（1）`POST /api/push-tokens` 的 `userId` 是否真的只取自 bearer token、不信任 request body；（2）新表 upsert 的「同裝置換帳號會覆蓋 user_id」這個刻意設計，有沒有辦法在不掌握該裝置實際 token 的情況下被觸發（等同 token 被劫持/轉移）；（3）`pickupCredentialRepository.js` 新增的 `readyOrderCustomerUserIds`／`storeName` 是否真的有從 `credentialService.js` 回傳給前端的 HTTP 回應裡剝除，不是只看註解、要追實際程式路徑；（4）兩個通知觸發點會不會把通知送給不相關活動/店家的顧客；（5)送到 Expo push API 外部服務的內容有沒有不該外流的欄位

### 發現

沒有找到信心度達到門檻（8/10 以上）的漏洞。

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| — | — | 這次沒有新發現 | — | — |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 授權（`POST /api/push-tokens`） | `userId` 完全只取自 `getAuthenticatedUser(request)` 驗證過的 `authUser.id`，從未讀取 request body；跟 `server.js` 其他已驗證路由（例如標記可取餐）的既有寫法一致 |
| SQL 注入 | `expoPushToken`／`platform` 全程走參數化查詢（`$1`-`$4`），`pushTokenRepository.test.js` 有專門測試把 SQL 注入字串當參數值傳入，確認不會被拼接進 SQL 字串 |
| Token 換帳號覆蓋（刻意設計） | `ON CONFLICT (expo_push_token)` 這個 upsert 需要呼叫者已經持有那支 Expo token 的實際字串值（一長串裝置專屬、無法猜測的字串），且新路由從來不會把任何使用者的 token 值回傳、列出或以其他方式外洩給其他使用者或角色——沒有「不掌握裝置本身就能覆蓋」的路徑 |
| 資料外洩：取貨可取餐回應 | 追過實際程式碼、不只看註解：`credentialService.js` 用解構賦值把 `readyOrderCustomerUserIds`／`storeName` 從回傳物件剝除，`server.js` 把這個已剝除的結果原封不動送給 `sendJson`；新增的單元測試也明確斷言這兩個欄位不會出現在回傳物件裡 |
| 跨用戶通知定位 | 取貨可取餐：只有這次呼叫裡真的從 `not_ready` 轉成 `ready` 的訂單（`rowCount === 1`）才會被列入通知名單，且查詢本來就以 `activity_id` 限定範圍，跟既有的權限檢查（`can_manage`）用同一把尺；開團成功：收件人來自既有、這次沒改動的 `plan.orders[].customerUserId`，這個欄位本來就被同一支函式拿去做實際請款/撤銷，若有跨活動外洩會是先於這次改動就存在的金流正確性問題，不是本次新增 |
| 送到 Expo 外部 API 的內容 | payload 只有 `{to, title, body, data}`；`data` 只帶 `{type, activityId}` 或 `{type}` 這類內部識別碼；`body` 文字只有活動名稱／店名（本來就是顧客看得到的公開資訊），沒有金額、使用者 ID、憑證或其他敏感欄位 |
| 重試/冪等 | 結算重試遇到 `completion.alreadyCompleted` 不會重送；取貨標記重複呼叫已可取的訂單不會重送——都有對應單元測試覆蓋 |

**這次沒審查到／沒驗證到的部分**：這次的 migration（`009_push_tokens_postgres.sql`）尚未套用到任何真實資料庫（開發或 Azure），套用後建議之後再對真實資料庫做一次端對端確認；顧客端裝置實際收到推播的行為（前景／背景／關閉三種狀態）需要重新打包 APK 並用實機驗證，這次沒有做，也不在 `/security-review` 的檢查範圍內。

---

## 2026-10-03 — 離線展示模式（`EXPO_PUBLIC_DEMO_MODE`，新功能）與對外展示連線

**範圍**：新增 `mobile/src/utils/demoMode.js`、`mobile/src/mock/demoContent.js`、`mobile/src/mock/demoBackend.js`；加了展示模式分支的既有檔案——登入畫面 `RoleSelectScreen.jsx`、購物車 `CartScreen.jsx`、全域狀態 `AppStateProvider.jsx`（`submitCart`／`updateOrderItems`／`cancelOrder`／標記可取餐／取餐核銷／取消團購等動作）、`apiClient.js`（菜單、統計、省錢統計、開團、菜單新增修改）；另外審視「用 Expo tunnel（ngrok）讓外部掃 QR code 連到本機開發伺服器」這個做法
**觸發原因**：AGENTS.md 規則——改動碰到登入畫面與付款／訂單送出的 Mobile 程式碼（雖然只是加分支、沒有改後端與金額計算）；展示模式會繞過真實登入，必須確認它不能被誤開或被利用
**方法**：聚焦複查，不是整個 branch 的 diff 掃描（工作目錄裡另有其他 session 的未提交文件改動）。追了每一個 `isDemoMode()` 呼叫點（共 28 處，都在 `mobile/src`），並確認旗標在哪些建置／設定檔裡有被設定

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 低 | Expo tunnel（`expo start --tunnel`） | 展示時把本機的 Metro 開發伺服器透過 ngrok 公開到網際網路，任何拿到網址的人都連得到。內容只有已經打包在 APK 裡的前端程式碼與本來就公開的 `EXPO_PUBLIC_*` 設定（沒有後端機密，展示模式也完全不連後端），但**沒有驗證**開發伺服器是否還有其他只該給本機用的內部端點（例如開啟編輯器之類）會被外部呼叫到 | 只在展示期間開著、用完關掉；正式展示建議改成 `expo export -p web` 的靜態網站，不要開著開發伺服器 | 評估後暫不修（展示用、時間有限；已記錄限制） |
| 低 | ngrok 授權碼 | 這次設定 tunnel 時，使用者把 ngrok authtoken 貼在對話裡；已寫進使用者家目錄的 ngrok 設定檔（不在 repository 內，未提交） | 展示結束後到 ngrok dashboard 重設這組授權碼 | 待處理（由使用者執行） |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 能否在正式版被打開 | `EXPO_PUBLIC_DEMO_MODE` 是建置時就寫死的常數（Metro 會把 `process.env.EXPO_PUBLIC_*` 直接替換進程式碼），使用者在已安裝的 App 裡沒有任何方式切換。旗標只出現在 `mobile/.env.example` 的註解行，`mobile/.env`（已被 gitignore）、`eas.json`、`app.config.js`、GitHub Actions 設定都沒有設定它；開發時是用命令列暫時帶入，沒有寫進任何檔案 |
| 認證繞過 | 展示模式的「登入」只呼叫本機的 `selectRole()` 改畫面狀態，**不會取得、也不會設定任何 bearer token**（沒有呼叫 `setAuthToken`）。就算有人拿到展示版，要對後端做任何事仍會被後端以未登入／權限不足拒絕——後端的授權邏輯這次完全沒有改動 |
| 金流與金額 | 展示模式下的「付款成功」是 `authorizeLinePayPayment()` 這個本來就存在、只改本機畫面狀態的動作，不會呼叫 LINE Pay 或任何後端；送出訂單時改用本機組出的假訂單編號取代 `createOrder`。後端的金額重算、冪等、鎖等保護完全沒有被改動或繞過 |
| 資料寫入 | 展示模式下，假訂單、假菜單、假團購都只存在記憶體（`demoBackend.js` 的模組變數與 React state）；刻意不讀寫既有的本機 prototype 儲存，避免假資料混進同一台裝置之後的真實使用 |
| 資料外洩 | 展示用資料取自 seed 檔裡本來就公開的店家與菜單資訊（店名、地址、品項、價格），沒有任何顧客個資、金流憑證或機密 |
| 後端 | 這次沒有改動任何 `backend/` 檔案 |

**這次沒審查到／沒驗證到的部分**：手機 App 原生建置內使用展示模式的行為沒有驗證；Expo 開發伺服器對外暴露的完整端點清單沒有逐一檢查（見上表第一列）。

---

## 2026-10-04 — 顧客端推播擴充：未成團／原價購買／請款失敗／團購取消／取餐截止提醒

**範圍**：`backend/payments/settlementService.js`（`buildSettlementNotifications` 與結算後的發送迴圈）、`backend/payments/merchantActivityCancelService.js`（取消團購後通知）與 `merchantGroupBuyActivityCancelRepository.js`（查詢多帶 `customer_user_id`、`title`）、`backend/pickup/expirationService.js`（取餐截止提醒排程）與 `pickupCredentialRepository.js`（`claimPickupRemindersPostgres`）、`backend/server.js`（三個取消入口與排程的接線）、`database/migrations/010_order_pickup_reminder_postgres.sql`（`orders.pickup_reminder_sent_at`）。
**觸發原因**：AGENTS.md 規則——改動接在金流結算與團購取消流程旁（通知文案會對顧客說「不會扣款」「已依原價購買」「扣款失敗」，講錯會誤導顧客對自己的錢的認知），且新增資料庫欄位與排程。呼應 2026-09-30 同主題那筆（顧客端推播第一版，只有成團與可取餐兩種）：延續它的設計（失敗不拋例外、結算重試不重送），這次補上它沒涵蓋的結果。
**方法**：聚焦複查這次 diff，不是整個 branch 掃描。追每個通知「對象從哪來」「說的話是否與實際狀態一致」「會不會重複發」「失敗會不會拖垮核心流程」。對真實 PostgreSQL（本機開發伺服器上一個一次性 schema，跑完整套 migration 001–010 後驗證，結束後整個 schema 已刪除，開發資料庫本身沒有被讀寫）驗證新 SQL。

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 低 | `pickupCredentialRepository.js` `claimPickupRemindersPostgres` | 提醒採「先認領再發送」（至多一次）：認領後若 Expo 推播呼叫失敗，該筆訂單不會再被提醒 | 提醒屬方便性功能，漏發的代價是顧客少一次提醒、不影響訂單或金額；若之後要補強，需另加發送結果欄位與重試，會增加複雜度 | 評估後不修（刻意取捨，已寫在程式註解） |
| 低 | 部署順序 | 取餐提醒需要 migration 010；若程式先於 migration 上線，只有在「有取餐窗口剛好進入最後 30 分鐘」時那條 `UPDATE` 會因欄位不存在而失敗，錯誤被 `runDuePickupReminders` 接住並記錄，**不影響取餐逾期處理、結算、取消等核心流程** | 部署時先套 migration 010（本機開發資料庫與 Azure 資料庫都已於 10/4 套到 010；程式推送早於 Azure migration 約一小時，期間推播相關功能僅記錄錯誤） | 已處理 |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 通知對象能否被操弄 | 所有對象都來自資料庫列（結算 `plan.orders[].customerUserId`、取消 `listEligibleOrders` 的 `customer_user_id`、提醒 `UPDATE ... RETURNING customer_user_id`），再由 `pushTokenRepository.getPushTokensForUsers` 用使用者編號查裝置；沒有任何一條路徑接受 request body 裡的收件人或裝置 token。商家／管理員取消入口在發送前已通過原本的 `canManageStore` 授權 |
| 文案與實際狀態一致（金流相關） | 「不會扣款」只寄給「這次實際取消成功」的訂單（取消流程的 `cancelledOrderIds`；作廢失敗的訂單在 `failedOrderIds`，不通知）；已請款（captured／refunded）訂單依原有 `listEligibleOrders` 條件根本不在名單內，不會被告知「不會扣款」。結算的「未成團」只寄給 `void` 且結果為 `authorization_voided` 的訂單、「原價購買」只寄給 `capture` 且結果為 `captured` 的訂單、「扣款失敗」只寄給 `capture` 且結果為 `failed` 的訂單，全部以本輪實際結果為準，不是 `plan` 的預期動作 |
| 重複發送 | 結算：沿用原本「`!completion.error && !completion.alreadyCompleted` 才發」的守門，重試遇到已完成的結算不重送；取消：已取消的活動在更早的冪等分支就回傳，不會走到通知；提醒：認領本身（`pickup_reminder_sent_at IS NULL` → 現在）就是去重，兩個排程或兩個實例同時跑，PostgreSQL 的列鎖會讓後到者重新判斷條件後拿不到同一筆。真實 PostgreSQL 驗證：第一次認領 2 筆、第二次 0 筆 |
| 失敗隔離 | 結算與取消的發送都不 `await`，`notifyUsers` 本身不拋例外，外層另有 `.catch` 記錄；提醒整段包在 `try/catch`，失敗只回傳摘要。日誌只含活動編號、通知類型與錯誤訊息，不含推播 token 或顧客資料 |
| SQL 安全 | 新 SQL 全為參數化（`$1`、`ANY($2::text[])`），沒有字串拼接使用者輸入；`npm run check:sql-safety` 通過 |
| 資料外洩 | 推播內容只有活動標題、店名、取餐截止時間，都是顧客本來就看得到的資訊；內容不含金額、訂單編號或個資（`data` 只放通知類型與活動編號） |
| 權限／後端改動範圍 | 沒有新增 HTTP 路由、沒有改任何授權或金額計算；LINE Pay 請款與作廢邏輯本身未修改，只讀取它們的結果來決定要通知誰 |
| 自動化測試 | `npm test` 252/252 通過（新增 14 項：結算三種通知對象、取消通知對象與冪等、提醒認領 SQL／時間窗／去重／降級）；現有結算通知測試也依新行為更新 |

**同日後續（`/code-review` 三項發現已修）**：(1) 沒成團／原價購買的通知對象改為從訂單最終狀態讀取（新增唯讀查詢 `listSettlementOutcomeOrders`：`status != 'cancelled'` 且 `payment_status` 為 `authorization_voided`／`captured`），讓需要重試的結算也能通知到前幾輪已處理的顧客；讀取失敗時退回只用本輪結果，不影響結算。新查詢為參數化唯讀 SQL，已對開發資料庫唯讀執行確認語法與欄位。扣款失敗的通知對象仍以本輪結果為準（`payment_status = 'failed'` 也可能是顧客授權階段失敗，不能直接當成請款失敗）。(2) 取餐提醒標記後若推播沒送出，現在會記錄一筆錯誤日誌並計入 `undeliveredGroupCount`（沒有任何已登記裝置不算失敗）。(3) `PICKUP_REMINDER_LEAD_MINUTES` 支援小數。`npm test` 257/257 通過。

**這次沒審查到／沒驗證到的部分**：推播實際送達裝置（前景／背景／App 關閉）沒有驗證，仍需要重新打包 APK 後在真機測；migration 010 已於同日套用到本機開發資料庫與 Azure 資料庫（兩邊套用前都先 `pg_dump` 備份、套用後主要表筆數前後一致；Azure 連線全程使用完整憑證驗證，臨時防火牆規則需由使用者刪除）；已請款訂單在「管理員無條件取消」情境下仍不會收到任何通知（它們不在取消名單內，退款維持走獨立退款流程），這是這次範圍外的已知缺口。

---

## 2026-10-09 — 學校 VM 部署：後台僅限本機開關、http 展示版 APK、VM 安裝與備份腳本

**範圍**：`backend/adminSurfaceGuard.js` 與 `backend/server.js` 的請求入口守門（`ADMIN_WEB_LOOPBACK_ONLY`）、`mobile/app.config.js` 的 `ALLOW_CLEARTEXT_HTTP`／`FREEZE_UPDATES`、`scripts/build-android-apk.js`（`--backend-url`、`--demo`）、`scripts/install-vm-service.ps1`、`scripts/backup-vm-database.ps1`、`scripts/update-vm-server.ps1`、`scripts/check-vm-readiness.ps1`、`docs/school-vm-deployment.md`。
**觸發原因**：AGENTS.md 規則——改動碰到身份驗證與對外暴露面；專題展要把後端放到有公開 IP 的學校 VM，且沒有網域名稱，只能用 http。
**方法**：聚焦複查這次改動。對守門邏輯寫 5 項單元測試；用真的後端（所有背景排程關閉、不碰資料）從 127.0.0.1 與本機區網位址各請求一次，確認被擋與沒被擋的路徑；實際打包 VM 版 APK 後檢查 manifest 與 JS 內容。

### 發現

| 嚴重度 | 位置 | 問題 | 建議修法 | 狀態 |
|--------|------|------|----------|------|
| 中 | 整體（VM 公開 IP＋http） | 沒有 HTTPS 時，顧客的 App session token 與付款相關請求以明碼傳輸，在網路上可被旁觀者看到 | 取得網域名稱後改 HTTPS（反向代理加憑證）；在那之前只放展示用資料、不使用真實個資 | 待處理（展示用途接受此風險，已寫入手冊「安全」一節） |
| 中 | `/admin` 後台 | 後台共用密碼在 http 下明碼傳輸，且登入頁對全世界開放 | 新增 `ADMIN_WEB_LOOPBACK_ONLY=true`：`/admin`、`/dev-console`、`/api/admin/` 只回應本機請求，其他看起來是 404 | 已修（需在 VM 的 `backend/.env` 開啟，預設關閉以維持既有行為） |
| 低 | `adminSurfaceGuard.js` | 若 VM 上另外架本機反向代理，所有請求都會來自 127.0.0.1，守門等於失效（刻意不信任 X-Forwarded-For，避免被偽造） | 手冊與程式註解都寫明「不要與本機反向代理併用」 | 評估後不修（用文件警告） |
| 低 | 遠端桌面 3389 | VM 有公開 IP，遠端桌面對網際網路開放 | 強密碼、網路層級驗證（NLA）、請學校限制來源 | 待處理（VM 管理端，手冊已列） |
| 低 | VM 版 APK | `--backend-url http://…` 的 APK 允許明碼 http | 只有帶 http 網址的專用建置才開 `ALLOW_CLEARTEXT_HTTP`；預設 release 建置仍拒絕 http（已驗證 manifest） | 已控管 |
| 低 | 評估版 Windows Server | 授權到期後系統會定時關機，也代表這台機器可能未被正式維護與更新 | 確認剩餘天數，必要時請 IT 換正式授權 | 待處理 |

### 沒發現問題的部分

| 面向 | 檢查結果 |
|------|----------|
| 守門邏輯的正確性 | 只收緊、不放寬：旗標關閉時行為與以前完全相同；旗標開啟時，非本機請求對 `/admin`、`/dev-console`、`/api/admin/` 回 404，`/health`、`/api/stores`、LINE Pay 回跳路由不受影響（真實後端實測：本機 `/admin/login` 200；區網位址 `/admin/login`、`/admin/accounts`、`/dev-console`、`/api/admin/…` 皆 404，`/health`、`/api/stores` 200）。路徑比對用精確前綴，`/administrator`、`/api/administrators` 不會被誤擋（單元測試） |
| 開發登入模式 | `install-vm-service.ps1` 在 `backend/.env` 有 `AUTH_DEV_MODE=true` 時拒絕安裝；手冊明列必須為 `false` |
| 專用 APK 的更新風險 | VM 版與展示版 APK 都關閉 EAS Update（manifest 的 `expo.modules.updates.ENABLED=false` 已驗證），避免之後從開發機發布的更新把它們導回 Azure 或離開展示模式 |
| 打包產物與環境變數 | 發現並修正：Metro 與 Gradle 都不會因為只有環境變數改變而重新產生 JS，第一次 `--backend-url` 建置的 JS 裡仍是 Azure 網址。現在每次建置前清掉 Metro 快取與 Gradle 的 JS 產物；重建後驗證 JS 內只有 VM 網址、沒有 Azure 網址、沒有展示旗標 |
| 機密處理 | 備份腳本從 `DATABASE_URL` 取得密碼，只放在該次執行的環境變數，結束就移除，不印出、不寫檔；檢查腳本不印出 `.env` 內容；資料庫備份放 VM 本機 `C:\apps\backups`，不進 Git |
| 資料庫暴露 | 手冊要求 PostgreSQL 只聽本機、不新增 5432 的入站規則，並提供檢查指令 |
| SQL／注入 | 這次沒有新增 SQL；新增腳本不拼接使用者輸入到命令中（路徑與埠為參數） |

**這次沒審查到／沒驗證到的部分**：VM 上的實際設定（尚未部署）、學校邊界防火牆是否放行 3000 埠、HTTPS 方案、遠端桌面的實際強度、`/api/admin/` 在開關開啟時對遠端管理用途的影響（預期行為：只能本機使用）。

