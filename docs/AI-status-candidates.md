# 狀態模型

最後更新：2026-08-13

## 語言規則

本文件整理系統中各種狀態值，例如團購狀態、訂單狀態、付款狀態與取餐狀態。

- status value 必須保留英文，例如 `recruiting`、`authorized`、`ready`。
- 中文說明用來解釋每個狀態的意義與流程。
- 不要為同一個狀態另外新增中文狀態值給程式使用。
- 新增或修改 status 時，必須同步更新本文件，避免 mobile、backend、database 用不同名稱。
- PostgreSQL 第一版 status 欄位會使用 `text check (...)`，不是 enum。

以下狀態反映目前程式碼與 schema 方向。若文件中標示 mobile、backend、database 有差異，必須在實作對應 API 前先決定。

## 使用者實際看到的狀態

顧客端會看到：

| 類型 | 顯示文字     |
| ---- | ------------ |
| 訂單 | 待付款       |
| 訂單 | 已加入團購   |
| 訂單 | 訂單已鎖定   |
| 訂單 | 扣款失敗     |
| 訂單 | 製作中       |
| 訂單 | 可取餐       |
| 訂單 | 已取餐       |
| 訂單 | 逾期未取     |
| 訂單 | 訂單已取消   |
| 訂單 | 未成團       |
| 訂單 | 已退款       |
| 付款 | 待付款       |
| 付款 | 訂單成立     |
| 付款 | 扣款失敗     |
| 付款 | 授權已取消   |
| 付款 | 已退款       |

店家端會看到：

| 類型 | 顯示文字     |
| ---- | ------------ |
| 團購 | 招募中       |
| 團購 | 已達標       |
| 團購 | 製作中       |
| 團購 | 可取餐       |
| 團購 | 團購已取消   |
| 團購 | 未成團       |
| 訂單 | 新訂單       |
| 訂單 | 訂單已鎖定   |
| 訂單 | 待付款       |
| 訂單 | 製作中       |
| 訂單 | 可取餐       |
| 訂單 | 已取餐       |
| 訂單 | 逾期未取     |
| 訂單 | 訂單已取消   |
| 訂單 | 已退款       |
| 付款 | 待付款       |
| 付款 | 已付款       |
| 付款 | 授權已取消   |
| 付款 | 已退款       |

## 訂單顯示流程規則

1. 顧客送出訂單前，購物車不顯示訂單狀態，只顯示購物車內容與金額。
2. 顧客送出訂單後，若尚未完成 LINE Pay 授權，顯示「待付款」。
3. 顧客在 LINE Pay 頁面取消付款授權或關閉付款頁，訂單仍顯示「待付款」，不計入團購杯數。
4. 顧客完成 LINE Pay 預授權後，顧客端顯示「訂單成立」，店家端顯示「已付款」，訂單正式加入團購杯數統計。
5. 團購截止前 30 分鐘以前，顧客可以修改訂單或退出團購。
6. 團購進入截止前 30 分鐘後，顧客顯示「訂單已鎖定」，退出團購與修改訂單按鈕變灰且不可點選。
7. 團購截止後進行正式扣款期間，不另外顯示「結算中」，顧客仍顯示「訂單已鎖定」。
8. 團購達標且扣款成功後，顧客訂單、店家訂單與團購整體顯示「製作中」。
9. 團購達標但扣款失敗時，系統最多自動請款三次；仍失敗時，顧客顯示「扣款失敗」，並可在取餐開始前 15 分鐘以前重新付款。店家仍可看到該筆訂單，但顯示「待付款」且以灰色呈現，不列入製作清單。
10. 扣款失敗後，顧客重新付款成功時，顧客訂單、店家訂單與團購整體改為「製作中」，該筆訂單加入製作清單。
11. 扣款失敗後若顧客一直沒有重新付款，顧客維持「扣款失敗」，店家維持灰色「待付款」，到取餐時間結束後移到歷史訂單。
12. 團購未達標且顧客沒有勾選「未達優惠仍以原價購買」時，顧客顯示「未成團」，授權取消，訂單直接進入歷史訂單。
13. 團購未達標但顧客有勾選「未達優惠仍以原價購買」時，系統依原價扣款；扣款成功後顧客訂單、店家訂單與團購整體顯示「製作中」。
14. 團購未達標且只有部分顧客勾選原價購買時，有勾選且扣款成功的訂單進入「製作中」；沒有勾選的顧客顯示「未成團」並直接進入歷史訂單。
15. 店家可逐筆或整批標記可取餐；只將選定且已扣款成功的訂單設為 `pickupStatus = ready` 並顯示取餐憑證，其餘訂單維持原狀。第一筆可取餐時團購進入 `ready_for_pickup`，表示已開始供餐，不代表全部訂單製作完成。
16. 店家可點選個別顧客訂單，核對取餐憑證或取餐代碼後點選「已取餐」。
17. 店家點選「已取餐」後，該顧客訂單在顧客端與店家端顯示「已取餐」，並移到歷史訂單。
18. 取餐開始時間超過 3 小時後，該團購與相關顧客訂單移到歷史訂單；已取餐顯示「已取餐」，未取餐顯示「逾期未取」。
19. 店家在截止前 30 分鐘以前可以取消團購；取消後團購顯示「團購已取消」，顧客訂單顯示「訂單已取消」，尚未請款的授權取消。
20. 店家進入截止前 30 分鐘後，或團購已截止、製作中、可取餐時，不能取消團購，也不能取消單一顧客訂單。
21. 付款已成功但後續需要退款時，這是後台或人工處理狀態；顧客與店家顯示「已退款」，該筆訂單不進入製作清單並移到歷史訂單。

## 團購活動

狀態值：`draft`、`recruiting`、`confirmed`、`failed`、`ordering`、`ready_for_pickup`、`completed`、`cancelled`。

預期流程：

```text
draft -> recruiting -> confirmed -> ordering -> ready_for_pickup -> completed
                   \-> failed
recruiting/confirmed/ordering -> cancelled
```

- `confirmed`：至少達到一個優惠門檻；在截止時間或最大容量前仍可能繼續開放加入。
- `ordering`：截止時間已過，商家正在準備已成立訂單。
- `cancelled`：商家或系統後台明確取消，不代表刪除資料。

需要 history：是。

## 訂單

目前 schema 支援的狀態值：`draft`、`submitted`、`locked`、`cancelled`、`completed`。

訂單不使用 `readyForPickup` 作為 order status。正式方向是訂單維持 `locked`，並以 `pickupStatus = ready` 表示可取餐。mobile 若仍有 `readyForPickup` 顯示或 route 轉換，應在後續整理時移除。

預期流程：

```text
draft -> submitted -> locked -> completed
   \        \          \-> cancelled
    \--------> cancelled
```

需要 history：是，特別是 authorization 後的訂單修改。

## 付款

狀態值：`pending`、`authorized`、`captured`、`authorization_voided`、`failed`、`refunded`。

使用者顯示文字：

| 系統狀態               | 顧客看到         | 店家看到         | 說明 |
| ---------------------- | ---------------- | ---------------- | ---- |
| `pending`              | 待付款           | 待付款           | 訂單已建立，但尚未完成 LINE Pay 付款授權。 |
| `authorized`           | 訂單成立         | 已付款           | 顧客已完成預授權，訂單成立並加入團購統計，但尚未正式請款。 |
| `captured`             | 已付款           | 已付款           | 團購截止結算後，系統已完成實際請款。 |
| `authorization_voided` | 授權已取消       | 授權已取消       | 尚未請款的授權已取消。 |
| `failed`               | 扣款失敗         | 待付款           | 正式請款失敗，或付款流程失敗且需要顧客重新付款；店家端以灰色待付款呈現，不列入製作清單。 |
| `refunded`             | 已退款           | 已退款           | 已請款金額完成退款。 |

顧客端與店家端不直接顯示「待預授權」或「已預授權」。預授權是系統內部金流狀態；對顧客而言，`authorized` 代表付款授權動作已完成且訂單已加入團購，因此顯示「訂單成立」；店家端仍顯示「已付款」。若後續請款沒有成功，狀態改為 `failed`；顧客端顯示「扣款失敗」，店家端顯示灰色「待付款」。

預期流程：

```text
pending -> authorized -> captured
                    \-> authorization_voided
pending/authorized/captured -> failed（僅限對應操作）
captured -> refunded
```

需要 provider events 與 idempotency records：是。

## 退款申請

狀態值：`pending`、`approved`、`rejected`。此為 `refund_requests` 資料表狀態，與 `payment_refunds.status`（`pending`、`refunded`、`failed`）為兩個不同欄位；`refund_requests.status = approved` 只代表營運已核准並成功觸發 provider refund，實際請款結果仍以對應 `payment_refunds` 記錄與 `orders.payment_status` 為準。

| 系統狀態   | 說明 |
| ---------- | ---- |
| `pending`  | 商家已提出退款申請，等待營運審核。同一筆 `payment_capture` 同時只允許一筆 `pending` 申請。 |
| `approved` | 營運已核准並成功執行 LINE Pay refund；`resulting_payment_refund_id` 指向對應 `payment_refunds` 記錄。 |
| `rejected` | 營運駁回申請，不呼叫 provider；`rejection_reason` 保存駁回原因。 |

預期流程：

```text
pending -> approved
      \--> rejected
```

若核准時呼叫 provider 失敗（`refundLinePayPayment` 拋出錯誤），申請維持 `pending`，供營運使用相同 idempotency key 重試；第一版無正式告警通知管道。

需要 audit log：是，`refund_request_created`／`refund_request_approved`／`refund_request_rejected` 皆寫入 `audit_logs`。

## 商家退款標記（方案 B：自報退款）

狀態值：`active`、`revoked`。此為 `merchant_refund_marks` 資料表狀態（2026-10-21 新增），與上面「退款申請」的 `refund_requests.status`／`payment_refunds.status` 是完全獨立的狀態機：這張表沒有 provider 呼叫、沒有審核流程，一筆紀錄寫入當下就是終局事實，只能在 24 小時內由本人撤銷。訂單本身的 `orders.payment_status` 不會因為這個狀態改變而變動；顯示用的退款狀態（全額／部分／無退款）是即時加總同一張訂單目前 `active` 狀態的紀錄金額算出來的，不是存成單一欄位。

| 系統狀態 | 說明 |
| -------- | ---- |
| `active`  | 商家標記了這筆退款，目前仍然算作「已發生」，計入統計的退款淨額。 |
| `revoked` | 商家在 24 小時內自行撤銷這筆標記（例如填錯金額），不再計入統計。 |

預期流程：

```text
active -> revoked
```

需要 audit log：是，`merchant_refund_mark_created`／`merchant_refund_mark_revoked` 皆寫入 `audit_logs`。

## 商家申請

狀態值：`pending`、`approved`、`rejected`。此為 `merchant_applications` 資料表狀態，是這個專案第一個「執行期間會建立商家資料」的狀態機（其餘商家帳號都是一次性 seed SQL 建立的）。

| 系統狀態   | 說明 |
| ---------- | ---- |
| `pending`  | 申請人已完成 Google 身份驗證並送出店家資料，等待管理員審核。同一個 Firebase UID 同時只允許一筆 `pending` 申請。 |
| `approved` | 管理員已核准；同一個交易裡建立（或重用既有的）`users`、新增 `merchants`／`stores`／`merchant_users`／`user_roles`（role='merchant'）。`resulting_merchant_id`／`resulting_store_id`／`resulting_user_id` 指向新建立的資料。 |
| `rejected` | 管理員駁回，不建立任何商家資料；`rejection_reason` 保存駁回原因。 |

預期流程：

```text
pending -> approved
      \--> rejected
```

需要 audit log：是，`merchant_application_submitted`／`merchant_application_approved`／`merchant_application_rejected` 皆寫入 `audit_logs`。

## 舊候選：商家接單

狀態值：`pending`、`accepted`、`rejected`、`cancelled`。

預期流程：`pending -> accepted/rejected/cancelled`。

最新產品規則不需要店家逐筆確認接單。顧客預授權成功後即視為有效加入團購，因此 `merchant_acceptance_status` 是早期候選欄位；第一階段可在預授權成功後固定為 `accepted`，後續 schema review 可考慮移除。

## 取餐

schema 狀態值：`not_ready`、`ready`、`picked_up`、`cancelled`、`expired`。

不保存 `preparing` 作為 pickup status。製作中由 activity/order/payment 狀態推導；取餐狀態只保存 schema 中的狀態值。

預期流程：

```text
not_ready -> ready -> picked_up
not_ready/ready -> cancelled
ready -> expired
```

取餐碼從 `ready` 開始顯示，不只是商家接單後就顯示。

- `ready`：店家已標記可取餐，顧客可以看到取餐憑證。
- `picked_up`：店家核對取餐憑證或取餐代碼後，已交付飲品。
- `expired`：取餐憑證已到期，訂單移至歷史訂單；逾期不自動退款，店家不再負原飲品保管責任。

取餐憑證到期規則：

1. 自取餐開始時間起保留 3 小時。
2. 取餐開始時間超過 3 小時後，該團購與相關顧客訂單移到歷史訂單。
3. 已取餐的顧客訂單顯示「已取餐」，未取餐的顧客訂單顯示「逾期未取」。
4. 店家仍可在歷史訂單中查看每位顧客的取餐狀態。
5. 若顧客在有效期間到店但店家無法交付，不得將訂單改為 `expired`。

## 優惠達標

Mobile 狀態值：`not_yet_qualified`、`qualified`、`failed`。

此狀態較適合由資料推導或由 settlement outcome 表示，而不是作為可任意變更的 activity status。截止時，應將權威結果保存到 `activity_settlements`。
