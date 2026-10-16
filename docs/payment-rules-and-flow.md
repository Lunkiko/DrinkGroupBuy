# 付款規則與流程

最後更新：2026-08-29

本文件紀錄目前已確認的付款商業規則，作為下一階段 LINE Pay 實作依據。

## 付款 Provider 方向

唯一付款 provider 是 LINE Pay。**LINE Pay「分離式請款」已於 2026-07-31 獲官方核准**（測試商店 `test_202606269512`），並已於 2026-08-08 完成 Sandbox 人工端對端驗證（詳見 `docs/line-pay-separated-capture-sandbox-checklist.md`），通過門檻全數達成。

信用卡（綠界 ECPay）曾於 2026-08-05 新增作為第二個 provider，唯一原因是當時 LINE Pay 分離式請款官方審核進度不確定；該原因已隨核准與驗證完成而解除，ECPay 於 2026-08-27 完全移除（見 `docs/AI-security-review-log.md` 2026-08-26／2026-08-27 兩筆記錄），不再是備援選項。本文件其餘規則（預授權、截止結算才請款、折扣分攤等）維持 provider 中立的寫法，日後若要新增其他 provider 仍可套用。

LINE Pay 實作與驗證進度詳見 `docs/AI-current-progress.md`「2026-08-08 LINE Pay 分離式請款 Sandbox 人工端對端驗證完成」與 `docs/line-pay-separated-capture-sandbox-checklist.md`。

## 已確認規則

### 核心付款模式

1. LINE Pay 採用先預授權 `authorization`，不是下單當下直接請款 `capture`。
2. 顧客只有在 LINE Pay 預授權成功後，才算正式加入團購。
3. 預授權成功後，該訂單立即計入團購杯數。
4. 店家不需要逐筆確認顧客訂單。
5. 顧客預授權成功後，店家不能拒絕或取消單筆顧客訂單。
6. 這樣可以避免店家故意不接第 50 杯，讓團購停在 49 杯以避開折扣門檻。
7. 實際請款 `capture` 會在團購截止結算時執行，因為那時才知道最終折扣級距。
8. 顧客若在 LINE Pay 頁面取消或返回，該次 pending authorization 必須在後端標記為 `failed`，訂單維持 `pending`，顧客端顯示「待付款」，顧客可以重新發起付款。
9. LINE Pay confirm 回跳後，後端寫入 `authorized` 前仍必須重新檢查團購容量；若容量已滿，該次 authorization 標記為 `failed`，訂單不得計入團購。
10. 若 LINE Pay provider confirm 已成功，但後端最後容量檢查失敗，系統必須立即嘗試取消該筆授權 `void`。
11. LINE Pay 官方支援分離式 confirm/capture 與 partial capture；但台灣 channel 預設是自動請款，使用前需向 LINE Pay 申請開通分離式請款。
12. 後端只有在 `LINE_PAY_CAPTURE_SEPARATED=true` 時才會送出 `options.payment.capture=false`；未開啟時會阻擋真 LINE Pay request，避免自動請款被誤當預授權。
13. 顧客必須在團購截止前完成 LINE Pay confirm，且後端成功寫入 `authorized`，才算加入團購。
14. 若顧客截止前進入 LINE Pay，但 confirm 回到後端時已達或超過截止時間，該授權視為逾時，不計入團購，系統會標記失敗並嘗試 void。
15. 顧客完成預授權後，雖然系統內部狀態是 `authorized`，但顧客端顯示「訂單成立」，店家端顯示「已付款」。此時尚未正式請款。
16. 團購截止後正式扣款期間不顯示「結算中」或「付款處理中」；顧客端仍顯示「訂單已鎖定」。
17. 團購截止時間一到，後端會直接拒絕新的 LINE Pay 付款請求（新訂單與 order revision 皆適用），回傳「此團購已經截止，無法再付款」，不會讓顧客在截止後才第一次建立預授權；此檢查與第 14 點（confirm 回跳時的逾時判定）互補，分別擋下「截止後才發起」與「截止前發起、截止後才 confirm」兩種情況。

### 優惠與原價購買

1. 顧客先用訂單原價金額進行預授權。
2. 團購截止結算時，系統計算最終杯數與優惠級距。
3. 如果團購達到優惠門檻，系統依折扣後金額請款。
4. 如果團購達到優惠門檻但請款失敗，顧客端顯示「扣款失敗」並可重新付款；店家端仍可看到該筆訂單，但顯示灰色「待付款」，且不列入製作清單。
5. 如果團購未達優惠門檻，且顧客有勾選接受原價購買，系統依原價金額請款。
6. 如果團購未達優惠門檻且顧客接受原價購買，但原價請款失敗，顧客端顯示「扣款失敗」並可重新付款；店家端顯示灰色「待付款」，且不列入製作清單。
7. 如果團購未達優惠門檻，且顧客沒有勾選接受原價購買，系統取消授權 `void`，顧客端顯示「未成團」與「授權已取消」，訂單直接進入歷史訂單。
8. 顧客端保留「未達優惠時接受原價購買」選項。
9. 顧客端對未請款金額的說明使用：「未請款金額會由 LINE Pay 或發卡銀行依規定釋放，實際時間以付款服務為準」。
10. `promotion_tiers.discount_percent`（2026-09-18 起，取代原本的 `discount_amount` 固定金額）代表該優惠級距的折扣百分比（1-99 的整數，例如 30 代表打 7 折／付原價 70%），不是固定金額，也不是單杯折扣。
11. 達標結算時，系統對**每一筆訂單各自**依該訂單自己的 `original_amount` 計算折扣，不是先算出一個活動共用的金額或每杯折扣再平分——因為不同訂單品項單價不同，同一個折扣百分比套用在不同訂單上，折扣金額本來就不會一樣。
12. 每筆訂單的應付金額使用 `ceil(original_amount * (100 - discount_percent) / 100)`（無條件進位到整數元，進位方向有利商家，跟舊制「尾差退商家」精神一致）；例如訂單原價 65 元、折扣 21%（7.9 折）時，`ceil(65 * 0.79) = 52` 元，折扣 13 元。
13. 因為是逐筆訂單直接算完直接進位，沒有「一包總折扣先分攤、分不完的尾差」這個概念，也不需要另外追蹤未分配尾差。進行中依目前杯數即時顯示「目前／下一級距的折扣百分比」，截止時重新計算；PostgreSQL 最終快照（`activity_settlements`）保存 `discount_percent`、`total_discount_amount`（結算後把每筆訂單折扣加總得出的衍生值）、`discount_funder` 與 `calculation_version`（`percentage_v1`）。
14. 活動發布時驗證：`discount_percent` 必須是 1-99 的整數；杯數門檻由小到大排列且不可重疊；**級距杯數門檻越高，折扣百分比必須嚴格更好**（例如 20 杯 7 折、30 杯 6 折要被拒絕，門檻更高卻折得更少不合理）。百分比折扣對非負價格數學上不可能讓應付金額變負數，所以不再需要「折扣是否超過店內最低單杯價格」這類跟菜單金額比較的檢查（舊制 `discount_per_cup_below_minimum`／`discount_per_cup_exceeds_minimum_unit_price` 已移除）。
15. 顧客端只有在 Backend 已保存並回傳 `activity_settlements` 快照後才顯示「最終結算結果」；顯示最終有效杯數、折扣百分比、訂單 `final_amount`。單純抵達截止時間仍只能等待 Backend 結算，不得由 Mobile 自行宣告最終金額。

> **2026-09-18 遷移備註**：改成百分比折扣時，`promotion_tiers.discount_amount`／`activity_settlements` 的 `discount_per_cup`／`allocated_discount_amount`／`undistributed_discount_amount` 欄位與 migration 003 的相關 CHECK constraint 已被 `database/migrations/008_percentage_discount_postgres.sql` 移除，改為 `discount_percent`／`total_discount_amount`。這是不相容的 schema 變更，套用 migration 008 前必須先清空 `group_buy_activities`（會 cascade 清掉 `promotion_tiers`／`orders`／`activity_settlements`），否則舊的金額折扣資料在新程式碼下會被誤讀成百分比。

### 活動時間限制

1. 店家建立團購時，截止時間必須在發布或開放招募後 24 小時內。
2. 24 小時限制是為了降低 LINE Pay 預授權過期風險。
3. LINE Pay 預授權成功後，若 LINE Pay 回傳授權到期時間，後端必須保存該時間。
4. 如果授權有效時間無法涵蓋團購截止時間與結算緩衝時間，系統不能把該授權視為有效加入團購。
5. 團購截止後，系統應立即進行結算。
6. 目前 `POST /api/merchant/group-buy-activities` 已先強制 `deadlineAt` 不可超過 `startAt` 後 24 小時；mobile 建立團購表單也會先做相同提醒與阻擋。
7. LINE Pay 授權有效期限不由本系統寫死固定時數；以 confirm 回傳的 `info.authorizationExpireDate` 為準。
8. 第一階段結算緩衝時間預設 30 分鐘，可由 `LINE_PAY_AUTHORIZATION_SETTLEMENT_BUFFER_MINUTES` 調整。
9. 若 `authorizationExpireDate` 缺失、格式無效，或早於 `deadlineAt + settlement buffer`，後端會把該 authorization 標記為 `failed`，並嘗試呼叫 LINE Pay void。

### 顧客修改與退出時間

1. 團購截止前 30 分鐘以前，顧客可以自由修改已授權的訂單，也可以退出團購。
2. 進入團購截止前 30 分鐘後（含剛好 30 分鐘），顧客不能退出團購；仍可修改已授權的訂單，但修改後的總杯數不能低於原本的總杯數（只能增加飲料，不能減少）。
3. 團購截止後，顧客不能修改訂單，也不能退出團購。
4. 30 分鐘鎖定規則用來保護店家備料、製作與系統結算。30 分鐘是每場團購的 `withdrawal_lock_minutes` 欄位預設值，後端以該欄位為準。
5. 實作位置：修改在 `orderRevisionRepository.js`，退出在 `customerOrderCancelRepository.js`；兩者被擋時都回 `order_locked_by_deadline`。

### 已授權訂單修改

1. 修改已授權訂單是替換流程，不是新增一筆正式訂單。
2. 顧客修改期間，原本已授權訂單仍然有效。
3. 系統會建立一份待確認的修改內容。
4. 新修改內容在新的預授權成功前，不會計入團購杯數。
5. 如果修改後杯數增加，系統只檢查並暫時保留增加的杯數差額。
6. 如果修改後杯數減少，沒有容量不足問題；最終杯數會在替換成功後才更新。
7. 顧客必須針對修改後金額完成新的 LINE Pay 預授權。
8. 如果新的預授權成功：
   - 修改後訂單內容正式生效；
   - 新預授權成為有效授權；
   - 舊預授權會被取消授權 `void`；
   - 團購杯數依杯數差額更新。
9. 如果新的預授權失敗、逾時或顧客取消：
   - 修改內容不生效；
   - 原訂單維持不變；
   - 原本預授權繼續有效；
   - 原本杯數繼續計入團購。
10. 因為新舊預授權會短時間重疊，顧客可能需要足夠額度才能完成增加金額的修改。
11. 目前第一版已用 `order_revisions` 保存待確認修改內容；`POST /api/orders/:orderId/revisions` 建立 revision，mobile 付款頁會在 `POST /api/payments/line-pay/request` 帶 `orderRevisionId` 發起新預授權。
12. 新預授權 confirm 成功後，backend 在同一個資料庫交易中套用 revision，再嘗試 void 被替換的舊授權；若 void 舊授權失敗，會保留新訂單狀態並記錄失敗事件。

### 付款前規則同意

1. Mobile 透過 `GET /api/payment-rules/pickup-overdue` 顯示 Backend 目前有效的取餐與逾期未取規則全文與版本。
2. 顧客未勾選前不能建立 LINE Pay 預授權；Client 送出的資料只有明確同意旗標、規則類型與版本。
3. Backend 只允許訂單本人同意，並再次驗證規則類型與版本；管理員不能代替顧客建立同意證據。
4. Backend 以自己的權威規則全文與真實伺服器時間寫入 `order_rule_consents`，不採信 Client 傳入全文、帳號或時間。
5. 同一訂單、規則類型與版本採 append-only idempotent 紀錄；重試不覆寫第一次同意時間，規則升版則新增一筆歷史紀錄。
6. 未同意、版本過期或保存失敗都不會呼叫 LINE Pay provider。
7. 第一版已套用一般預授權與 revision 重新預授權；LINE Pay 手動重新付款沿用該訂單既有同意證據。

### 付款結果同步

1. LINE Pay confirm/cancel redirect 後，以後端資料庫狀態為準。
2. 後端 HTML 結果頁應提供 app deep link，例如 `drinkgroupbuy://payment/result?orderId=...`，讓顧客可回到 App 的付款畫面。
3. Mobile 收到 deep link 後，應導回付款畫面並重新讀取該筆訂單狀態。
4. Mobile 付款結果頁仍保留 polling 讀取訂單與付款狀態，作為 deep link 失敗時的備援。
5. App 從外部付款頁回到前景時，應重新讀取訂單狀態。
6. 若自動同步失敗，顧客可以手動重新整理付款結果。

### 顧客放棄付款後重試

1. 顧客開啟 LINE Pay 頁面後，若未完成確認或取消就退出（關閉頁面、返回 App），後端不會無限期擋下重試。顧客再次請求付款時，若既有授權仍是 `pending`，後端會先把舊的標記為失敗（`failure_reason: customer_retried_before_confirmation`），再建立一筆新的付款請求；不會回傳 `authorization_already_pending` 錯誤。
2. 採用此規則的原因：LINE Pay 沒有提供「主動取消尚未確認的付款請求」API（只有已確認的授權才能撤銷），只能等待 LINE Pay 自行判定過期，但其等待時間未公開，會讓顧客訂單無限期卡住。
3. 安全依據：即使顧客事後回到舊的 LINE Pay 頁面完成付款，後端在處理 confirm redirect 時會先檢查本地紀錄狀態是否仍為 `pending`；一旦已標記失敗，會直接拒絕、不會呼叫 LINE Pay 的正式確認 API，因此不會產生顧客不知情的授權扣款。
4. 此規則同時套用於新訂單與已成立訂單的修改（order revision）付款請求，皆重用同一套「標記放棄」邏輯，改單本身已成立的原訂單不受影響。

### Provider 事件與 webhook

1. 第一版不建立 `POST /api/payments/webhooks/line-pay` 作為必要流程。
2. LINE Pay Online API 第一版以 confirm/cancel redirect、後端資料庫狀態與 provider 狀態查詢作為付款同步依據。
3. `payment_provider_events` 仍保存 LINE Pay request、confirm、cancel、capture、void 與未來 provider event 的原始結果，方便追蹤與重試。
4. 若未來 LINE Pay 或其他 provider 提供 webhook，接收前必須先用 provider secret 驗證簽章；簽章驗證前不可修改 raw request body。
5. webhook 不直接覆蓋訂單狀態，只能作為「需要查詢 provider 狀態」的訊號。
6. webhook 或 redirect 重複送達時，系統必須用 provider transaction id、event type、idempotency key 與資料庫狀態轉換規則去重。
7. 若較舊事件晚到，例如已 `captured` 後又收到 `authorized` 類事件，系統不得倒退狀態，只保存事件並略過狀態更新。

### 退款

1. 尚未請款成功的預授權不可退款，應使用 `void` 取消授權。
2. 已請款成功的交易若需要退費，應使用 LINE Pay refund。
3. 退款可以是全額退款，也可以是部分退款。
4. 全額退款完成後，訂單付款狀態更新為 `refunded`，顧客端與店家端顯示「已退款」。
5. 部分退款完成後，系統保留 `payment_refunds` 紀錄；訂單是否另顯示部分退款，待後續 UI 規則決定。
6. 每次退款必須有 idempotency key；同一 key 重複送出時不得重複呼叫 provider 造成重複退款。
7. 退款成功與失敗都必須寫入 `payment_refunds`、`payment_provider_events` 與 `audit_logs`。
8. 第一版退款 API 先作為 admin / dev 後端操作，不先提供顧客或店家 App 操作入口。

### 結算失敗與自動重試

1. 第一版以系統自動重試為主，不做人工處理介面。
2. 團購截止結算時，若 `capture` 失敗，該訂單不得進入製作，也不得產生取餐憑證。
3. `capture` 失敗時，顧客端顯示「扣款失敗」；顧客可在取餐開始前 15 分鐘以前重新付款。
4. `capture` 失敗時，店家端仍可看到該筆訂單，但顯示灰色「待付款」，且不列入製作清單。
5. 顧客重新付款前，系統必須先查詢原交易狀態；確認未扣款後，以結算後最終金額建立新的 LINE Pay 直接付款交易，不再使用預授權。
6. 顧客重新付款成功後，顧客訂單、店家訂單與團購整體改為「製作中」，該筆訂單加入製作清單。
7. 進入取餐開始前 15 分鐘後，顧客不得再重新付款，重新付款按鈕應變灰且不可點選。
8. 顧客若沒有在重新付款期限前完成付款，顧客端維持「扣款失敗」，店家端維持灰色「待付款」，到取餐時間結束後移到歷史訂單。
9. 團購截止後正式扣款期間，顧客端不顯示「付款處理中」或「結算中」，仍顯示「訂單已鎖定」。
10. 系統自動請款最多三次：第一次於團購截止時執行；若為可重試的暫時性失敗，後續每隔 30 秒重試一次，總計最多三次。
11. 每次重試前，系統必須先查詢或確認目前 provider 狀態，避免重複請款或重複取消授權。
12. 三次自動請款都失敗，或遇到不可重試錯誤時，系統停止自動請款，改由顧客在允許時間內手動重新付款。
13. `void` 失敗時，系統持續重試；若授權自然過期，可視為釋放完成，但必須保留 provider event 與 status history。
14. 若系統仍無法判斷最終狀態，保留失敗狀態與稽核紀錄；這不是一般使用者操作流程，也不先做管理員介面。

### 容量規則

1. 最高優惠級距杯數視為團購容量上限。
2. 新訂單如果會超過團購容量上限，就不能完成預授權加入團購。
3. 已授權訂單修改時，如果增加的杯數差額會超過剩餘容量，就不能進入有效替換。
4. 待確認修改內容不能重複計算顧客原本訂單杯數。
5. 多位顧客同時預授權或修改訂單時，容量檢查必須由後端交易安全控制。
6. LINE Pay confirm redirect 必須在同一個資料庫交易中重新計算已授權杯數，確認沒有超過容量上限後才能把訂單付款狀態改為 `authorized`。

### 店家取消團購

1. 店家只能在團購截止前 30 分鐘以前取消已發布團購。
2. 進入團購截止前 30 分鐘後，店家不能取消團購。
3. 如果店家取消符合條件的團購，相關尚未請款的授權必須取消授權 `void`。
4. 目前產品方向不做「店家缺料回報」功能。
5. 店家備料與供應規劃視為店家營運責任。

## 截止結算流程

1. 團購到達截止時間。
2. 系統鎖定該團購並開始結算；顧客端仍顯示「訂單已鎖定」，不顯示「結算中」。
3. 系統計算有效預授權訂單。
4. 系統判斷最終優惠級距。
5. 系統逐筆處理已授權訂單：
   - 若達到優惠門檻，依折扣後金額請款 `capture`；
   - 若未達優惠門檻且顧客接受原價購買，依原價金額請款 `capture`；
   - 若未達優惠門檻且顧客不接受原價購買，取消授權 `void`。
6. 系統紀錄請款或取消授權結果。
7. 請款成功的訂單更新為已付款並進入製作中。
8. 請款失敗的訂單更新為扣款失敗；顧客可重新付款，店家端顯示灰色待付款，不列入製作清單。
9. 取消授權成功的訂單更新為授權已取消，若未達標且未接受原價購買，顧客訂單直接進入歷史訂單。
10. 系統更新團購活動狀態；只要有符合製作條件的訂單，團購整體進入製作中。
11. 只有請款成功的訂單，才進入店家製作與顧客取餐流程。
12. 目前 backend 已支援 admin 手動觸發單一團購結算，並在後端啟動時開啟 deadline settlement scheduler 自動掃描已截止團購。
13. Scheduler 在 `LINE_PAY_ENV=production` 時預設不啟動；必須明確設定 `SETTLEMENT_SCHEDULER_ALLOW_PRODUCTION=true`，避免未確認前發生真實請款。
14. 顧客從頭到尾沒有發起過任何一次 LINE Pay 付款請求的訂單（付款狀態始終是 `pending`），結算時系統會一併把該訂單標記為已取消，直接移入歷史訂單，不會無限期停留在「進行中」分頁；這與第 9 點「已建立授權但未達標」的取消路徑是兩條不同來源，但同樣導向已取消、進歷史訂單的結果。

## 實作方向

1. 付款邏輯維持集中在 `backend/payments/`。
2. LINE Pay secret 只放在後端本機環境檔。
3. 付款狀態必須保存於後端資料庫，不以 mobile local state 作為主資料。
4. 需要保存預授權、請款、取消授權、退款、provider event 與訂單替換紀錄。
5. 預授權、請款、取消授權、退款與結算 job 需要 idempotency，避免重複執行造成金額錯誤。
6. 預授權前與訂單替換正式生效前，都需要交易安全的容量檢查。
7. 上正式金流請款前，需要補齊結算重試 queue、provider 狀態查詢與告警。
8. LINE Pay cancel redirect 不可只清除記憶體暫存，也必須更新 `payment_authorizations`、`payment_provider_events` 與 `status_history`。
9. LINE Pay confirm/cancel redirect 應以後端資料庫查找 pending authorization；記憶體快取只能當加速輔助，不能是唯一依據。
10. LINE Pay confirm 寫入成功前需使用交易鎖定容量檢查；容量不足時需留下 provider event、status history 與 audit log。
11. LINE Pay void 使用官方 `POST /v3/payments/authorizations/{transactionId}/void`；成功後更新 `payment_authorizations.status = authorization_voided`，並同步更新訂單付款狀態與稽核紀錄；失敗時至少記錄 provider event 與 audit log。
12. LINE Pay capture 使用官方 `POST /v3/payments/authorizations/{transactionId}/capture`；成功後新增 `payment_captures`，更新 `payment_authorizations.status = captured`、`orders.payment_status = captured` 與 `orders.final_amount`，並記錄 provider event、status history 與 audit log。
13. LINE Pay refund 使用官方 `POST /v3/payments/{transactionId}/refund`；成功後新增 `payment_refunds`，全額退款時更新 `orders.payment_status = refunded`，並記錄 provider event 與 audit log。
14. 結算的折扣計算規則：各訂單折扣為 `original_amount - ceil(original_amount * (100 - promotion_tiers.discount_percent) / 100)`，逐筆訂單各自依自己的原價計算，不是先算出一個活動共用的每杯折扣再分攤。PostgreSQL `activity_settlements` 會保存不可變快照（`discount_percent`、`total_discount_amount`）；活動列表的 SQLite／PostgreSQL read runtime 均已回傳該快照供 Mobile 顯示。
15. 第一階段商家只能提出退款申請，由營運／補救權限確認後執行 LINE Pay refund；正式流程需檢查門市權限、可退餘額、冪等、跨程序鎖、audit log、reconciliation 與失敗告警。
16. 本機開發可使用 `mock_line_pay` 測試截止結算與退款，不呼叫外部 LINE Pay API；`npm run settlement:smoke` 會使用乾淨 schema 暫時建立 mock 預授權訂單，驗證達標 capture、未達標 fallback capture、void、scheduler due activity 結算、order revision 套用與 refund idempotency，並在測試後還原開發資料庫。

## 尚未決定

1. void 失敗時的具體重試間隔、最大重試時間與告警方式尚未設計。
2. Deadline settlement 已使用持久化 job 與 DB lease；兩程序 claim／lease takeover 測試已通過。PostgreSQL row-lock 驗收（8/20）與正式告警通知管道（8/24，`ALERT_WEBHOOK_URL`）皆已完成，細節見 `PROGRESS.md`。
