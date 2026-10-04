# 資料庫欄位規格

最後更新：2026-08-29

## 語言與範圍

本文件依據 `database/migrations/` 整理目前 PostgreSQL 開發資料庫欄位規格。PostgreSQL migration 是目前 Backend schema 的權威來源；`database/schema.sql` 僅供隔離的 SQLite 相容性測試。

必要的資料表名稱、欄位名稱、status value、type 與 constraint 保留英文；中文欄位名稱用於產品、文件與溝通。

SQLite 相容 schema 在時間、布林與 JSON 型態上可能不同；本文件的 `Type` 一律記錄 PostgreSQL 實際型態，不以 SQLite 儲存表示法取代。

## 欄位說明

| 欄位                 | 意義                             |
| -------------------- | -------------------------------- |
| No.                  | 該資料表內的欄位序號             |
| Field name           | 資料庫欄位名稱                   |
| 中文名稱             | 業務或產品語意名稱               |
| Type                 | 目前 PostgreSQL type             |
| Key                  | PK、FK、UNIQUE、INDEX 或空白     |
| 規則 / 格式 / 範圍   | 目前 constraint、格式或預期規則  |
| Example              | 範例值                           |

## `users`

| No. | Field name         | 中文名稱         | Type        | Key    | 規則 / 格式 / 範圍                                           | Example                     |
| --- | ------------------ | ---------------- | ----------- | ------ | ------------------------------------------------------------ | --------------------------- |
| 1   | `id`               | 使用者編號       | text        | PK     | 系統產生的唯一識別碼                                         | `user_001`                  |
| 2   | `login_name`       | 登入名稱         | text        | UNIQUE | 開發相容欄位；正式 Google-only login 不應依賴此欄位          | `customera`                 |
| 3   | `phone_number`     | 手機號碼         | text        | UNIQUE | 開發相容欄位；保存 normalized digits                         | `0911000001`                |
| 4   | `email`            | Email            | text        | UNIQUE | 可為 NULL；可作帳號連結輔助，不應取代 `firebase_uid`         | `alice@example.com`         |
| 5   | `password_hash`    | 密碼雜湊         | text        |        | 開發相容欄位；只保存 hash，不保存明文密碼                    | `scrypt:salt:hash`          |
| 6   | `firebase_uid`     | Firebase UID     | text        | UNIQUE | Firebase Auth 身份對應欄位；正式登入以此為主                 | `firebase-uid-abc123`       |
| 7   | `display_name`     | 顯示名稱         | text        |        | 必填                                                         | `Alice Wang`                |
| 8   | `status`           | 帳號狀態         | text        |        | `active`, `disabled`, `deleted`                              | `active`                    |
| 9   | `phone_verified_at`| 手機驗證時間     | timestamptz |        | 可為 NULL                                                    | `2026-06-25T09:50:00+08:00` |
| 10  | `email_verified_at`| Email 驗證時間   | timestamptz |        | 可為 NULL                                                    | `2026-06-25T09:55:00+08:00` |
| 11  | `last_login_at`    | 最近登入時間     | timestamptz |        | 可為 NULL                                                    | `2026-06-25T10:00:00+08:00` |
| 12  | `created_at`       | 建立時間         | timestamptz |        | ISO 8601 日期時間                                            | `2026-06-25T10:00:00+08:00` |
| 13  | `updated_at`       | 更新時間         | timestamptz |        | ISO 8601 日期時間                                            | `2026-06-25T10:30:00+08:00` |

## `user_private_profiles`

| No. | Field name      | 中文名稱     | Type        | Key    | 規則 / 格式 / 範圍                 | Example                     |
| --- | --------------- | ------------ | ----------- | ------ | ---------------------------------- | --------------------------- |
| 1   | `user_id`       | 使用者編號   | text        | PK, FK | References `users(id)`             | `user-customer-yinji`       |
| 2   | `real_name`     | 真實姓名     | text        |        | 僅供內部或管理用途                 | `顧客 A`                    |
| 3   | `contact_phone` | 聯絡電話     | text        |        | 僅供內部或管理用途                 | `0911000001`                |
| 4   | `contact_email` | 聯絡 Email   | text        |        | 可為 NULL                          | `alice@example.com`         |
| 5   | `created_at`    | 建立時間     | timestamptz |        | ISO datetime                       | `2026-06-05T00:00:00+08:00` |
| 6   | `updated_at`    | 更新時間     | timestamptz |        | ISO datetime                       | `2026-06-05T00:00:00+08:00` |

## `user_public_profiles`

店家可見顧客資訊應使用此表，不直接讀取 private profile。

| No. | Field name      | 中文名稱     | Type        | Key    | 規則 / 格式 / 範圍                         | Example                     |
| --- | --------------- | ------------ | ----------- | ------ | ------------------------------------------ | --------------------------- |
| 1   | `user_id`       | 使用者編號   | text        | PK, FK | References `users(id)`                     | `user-customer-yinji`       |
| 2   | `display_alias` | 對外顯示別名 | text        |        | 顯示給店家或其他顧客的名稱                 | `匿名顧客 A`                |
| 3   | `avatar_color`  | 頭像顏色     | text        |        | 可為 NULL；供 UI 顯示                      | `#4F46E5`                   |
| 4   | `privacy_mode`  | 隱私模式     | text        |        | `anonymous`, `display_name`                | `anonymous`                 |
| 5   | `created_at`    | 建立時間     | timestamptz |        | ISO datetime                               | `2026-06-05T00:00:00+08:00` |
| 6   | `updated_at`    | 更新時間     | timestamptz |        | ISO datetime                               | `2026-06-05T00:00:00+08:00` |

## `user_roles`

顧客／商家角色資料可以同時保留，但第一階段同時只允許其中一筆為 `active`。管理員切換介面時，目標角色設為 `active`、另一角色設為 `disabled`；不刪除角色 row，也不刪除該使用者的顧客資料、訂單或歷史紀錄。管理員角色不納入此切換。

| No. | Field name   | 中文名稱   | Type | Key             | 規則 / 格式 / 範圍                      | Example                     |
| --- | ------------ | ---------- | ---- | --------------- | --------------------------------------- | --------------------------- |
| 1   | `id`         | 角色編號   | text        | PK              | 系統產生的唯一識別碼                    | `role_001`                  |
| 2   | `user_id`    | 使用者編號 | text        | FK, UNIQUE pair | References `users(id)`；與 `role` 唯一 | `user_001`                  |
| 3   | `role`       | 角色       | text        | UNIQUE pair     | `customer`, `merchant`, `admin`        | `customer`                  |
| 4   | `status`     | 角色狀態   | text        |                 | `active`, `disabled`                   | `active`                    |
| 5   | `granted_at` | 授權時間   | timestamptz |                 | ISO 8601 日期時間                      | `2026-06-25T10:00:00+08:00` |

## `merchants`

| No. | Field name   | 中文名稱   | Type | Key | 規則 / 格式 / 範圍                 | Example                     |
| --- | ------------ | ---------- | ---- | --- | ---------------------------------- | --------------------------- |
| 1   | `id`         | 商家編號   | TEXT | PK  | 建議使用 `merchant_` 加唯一後綴    | `merchant_001`              |
| 2   | `name`       | 商家名稱   | TEXT |     | 必填                               | `青山手作茶`                |
| 3   | `status`     | 商家狀態   | TEXT |     | `active`, `disabled`               | `active`                    |
| 4   | `created_at` | 建立時間   | timestamptz |     | ISO 8601 日期時間                  | `2026-06-25T10:00:00+08:00` |
| 5   | `updated_at` | 更新時間   | timestamptz |     | ISO 8601 日期時間                  | `2026-06-25T10:30:00+08:00` |

## `merchant_users`

PostgreSQL 直接連結 `store_id`，不保存舊 SQLite 相容 schema 的 `merchant_id` 與 `permission_level`；每個帳號只綁定一間門市。切換成顧客介面時只將這筆關聯設為 `disabled`，門市與商家資料仍保留；切回商家介面時重新設為 `active`。

| No. | Field name  | 中文名稱         | Type        | Key        | 規則 / 格式 / 範圍                     | Example                     |
| --- | ----------- | ---------------- | ----------- | ---------- | -------------------------------------- | --------------------------- |
| 1   | `id`        | 店家帳號關聯編號 | text        | PK         | 系統產生的唯一識別碼                   | `merchant_user_001`         |
| 2   | `store_id`  | 門市編號         | text        | FK, UNIQUE | References `stores(id)`                | `store-001`                 |
| 3   | `user_id`   | 使用者編號       | text        | FK, UNIQUE | References `users(id)`                 | `user_merchant_001`         |
| 4   | `status`    | 關聯狀態         | text        |            | `active`, `disabled`                   | `active`                    |
| 5   | `created_at`| 建立時間         | timestamptz |            | ISO 8601 日期時間                      | `2026-06-25T10:00:00+08:00` |

## `stores`

| No. | Field name        | 中文名稱     | Type | Key        | 規則 / 格式 / 範圍                     | Example                     |
| --- | ----------------- | ------------ | ---- | ---------- | -------------------------------------- | --------------------------- |
| 1   | `id`              | 門市編號     | TEXT | PK         | 建議使用 `store_` 加唯一後綴           | `store_001`                 |
| 2   | `merchant_id`     | 商家編號     | TEXT | FK         | References `merchants(id)`             | `merchant_001`              |
| 3   | `name`            | 門市名稱     | TEXT |            | 必填                                   | `青山手作茶 中山店`         |
| 4   | `address`         | 地址         | TEXT |            | 必填                                   | `台中市北區三民路三段...`   |
| 5   | `phone`           | 電話         | TEXT |            | 可為 NULL                              | `04-1234-5678`              |
| 6   | `business_status` | 營業狀態     | TEXT |            | `open`, `closed`, `temporarily_closed` | `open`                      |
| 7   | `latitude`        | 緯度         | double precision | INDEX pair | 必填；地圖座標                         | `24.1505`                   |
| 8   | `longitude`       | 經度         | double precision | INDEX pair | 必填；地圖座標                         | `120.6839`                  |
| 9   | `pickup_closing_time` | 每日打烊時間 | TEXT |        | 可為 NULL（24 小時營業或尚未設定）；格式 `HH:MM`（24 小時制），以伺服器本機時區解讀；用於限制團購取餐開始時間不得晚到讓 3 小時取餐時段超過打烊 | `22:00`                     |
| 10  | `created_at`      | 建立時間     | timestamptz |            | ISO 8601 日期時間                      | `2026-06-25T10:00:00+08:00` |
| 11  | `updated_at`      | 更新時間     | timestamptz |            | ISO 8601 日期時間                      | `2026-06-25T10:30:00+08:00` |

## `menu_items`

| No. | Field name     | 中文名稱     | Type    | Key | 規則 / 格式 / 範圍                 | Example                     |
| --- | -------------- | ------------ | ------- | --- | ---------------------------------- | --------------------------- |
| 1   | `id`           | 菜單品項編號 | TEXT    | PK  | 建議使用 `menu_item_` 加唯一後綴   | `menu_item_001`             |
| 2   | `store_id`     | 門市編號     | TEXT    | FK  | References `stores(id)`            | `store_001`                 |
| 3   | `name`         | 品項名稱     | TEXT    |     | 必填                               | `白玉歐蕾`                  |
| 4   | `category`     | 分類         | TEXT    |     | 必填；分類命名仍可調整             | `鮮奶茶`                    |
| 5   | `description`  | 品項說明     | TEXT    |     | 可為 NULL                          | `鮮奶搭配紅茶`              |
| 6   | `base_price`   | 基本價格     | INTEGER |     | `>= 0`，以 NTD 整數保存            | `70`                        |
| 7   | `is_available` | 是否販售     | boolean |     | `true` = 販售，`false` = 停售       | `true`                      |
| 8   | `created_at`   | 建立時間     | timestamptz |     | ISO 8601 日期時間                  | `2026-06-25T10:00:00+08:00` |
| 9   | `updated_at`   | 更新時間     | timestamptz |     | ISO 8601 日期時間                  | `2026-06-25T10:30:00+08:00` |

## `customization_options`

| No. | Field name     | 中文名稱     | Type    | Key | 規則 / 格式 / 範圍                    | Example         |
| --- | -------------- | ------------ | ------- | --- | ------------------------------------- | --------------- |
| 1   | `id`           | 客製選項編號 | TEXT    | PK  | 建議使用 `option_` 加唯一後綴         | `option_001`    |
| 2   | `menu_item_id` | 菜單品項編號 | TEXT    | FK  | References `menu_items(id)`           | `menu_item_001` |
| 3   | `option_type`  | 選項類型     | TEXT    |     | `sweetness`, `ice`, `topping`, `size` | `ice`           |
| 4   | `label`        | 選項名稱     | TEXT    |     | 必填                                  | `少冰`          |
| 5   | `price_delta`  | 加價金額     | INTEGER |     | 預設 `0`，可為正數                    | `10`            |
| 6   | `sort_order`   | 排序         | INTEGER |     | 數字越小越前面                        | `1`             |
| 7   | `is_available` | 是否可選     | boolean |     | `true` = 可選，`false` = 停用          | `true`          |

## `menu_item_customization_rules`

| No. | Field name      | 中文名稱       | Type    | Key    | 規則 / 格式 / 範圍                                                   | Example         |
| --- | --------------- | -------------- | ------- | ------ | -------------------------------------------------------------------- | --------------- |
| 1   | `menu_item_id`  | 菜單品項編號   | TEXT    | PK, FK | References `menu_items(id)`；刪除品項時一併刪除規則                  | `menu_item_001` |
| 2   | `option_type`   | 選項類型       | TEXT    | PK     | `sweetness`, `ice`, `topping`, `size`                                | `topping`       |
| 3   | `min_selections` | 最少選擇數    | INTEGER |        | `>= 0` 且不得大於 `max_selections`                                   | `0`             |
| 4   | `max_selections` | 最多選擇數    | INTEGER |        | `0` = 不提供、`1` = 單選、`2` 以上 = 限制數量的多選；不得超過可用選項數 | `2`             |
| 5   | `created_at`    | 建立時間       | timestamptz |        | ISO 8601 日期時間                                                    | `2026-07-30T10:00:00+08:00` |
| 6   | `updated_at`    | 更新時間       | timestamptz |        | ISO 8601 日期時間                                                    | `2026-07-30T10:00:00+08:00` |

## `group_buy_activities`

| No. | Field name                | 中文名稱         | Type    | Key            | 規則 / 格式 / 範圍                                                                                     | Example                     |
| --- | ------------------------- | ---------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------------ | --------------------------- |
| 1   | `id`                      | 團購活動編號     | TEXT    | PK             | 建議使用 `activity_` 加唯一後綴                                                                        | `activity_001`              |
| 2   | `store_id`                | 門市編號         | TEXT    | FK, INDEX pair | References `stores(id)`                                                                                | `store_001`                 |
| 3   | `created_by_user_id`      | 建立者使用者編號 | TEXT    | FK             | References `users(id)`                                                                                 | `user_merchant_001`         |
| 4   | `title`                   | 活動名稱         | TEXT    |                | 必填                                                                                                   | `離峰優惠團購`              |
| 5   | `status`                  | 活動狀態         | TEXT    | INDEX pair     | `draft`, `recruiting`, `confirmed`, `failed`, `ordering`, `ready_for_pickup`, `completed`, `cancelled` | `recruiting`                |
| 6   | `start_at`                | 開始時間         | timestamptz |                | 目前規則為建立/發布時間或店家設定時間                                                                  | `2026-06-25T14:00:00+08:00` |
| 7   | `deadline_at`             | 截止時間         | timestamptz | INDEX          | 用於鎖單與結算；產品規則要求發布後 24 小時內                                                           | `2026-06-25T15:30:00+08:00` |
| 8   | `pickup_start_at`         | 取貨開始時間     | timestamptz |                | 顧客取貨資訊必填；至少晚於 `deadline_at` 30 分鐘，表單預設截止後 30 分鐘                                | `2026-06-25T16:00:00+08:00` |
| 9   | `pickup_end_at`           | 取貨結束時間     | timestamptz |                | 系統依 `pickup_start_at + 3 小時` 自動計算                                                            | `2026-06-25T19:00:00+08:00` |
| 10  | `maximum_cups`            | 最大杯數         | INTEGER |                | 可為 NULL；目前應等於最高 promotion tier，除非未來另定容量規則                                         | `40`                        |
| 11  | `withdrawal_lock_minutes` | 退出鎖定分鐘數   | INTEGER |                | 預設 `30`；截止前 30 分鐘不能修改或退出                                                                | `30`                        |
| 12  | `cancellation_reason`     | 取消原因         | TEXT    |                | 活動取消時填寫                                                                                         | `店家臨時設備維修`          |
| 13  | `created_at`              | 建立時間         | timestamptz |                | ISO 8601 日期時間                                                                                      | `2026-06-25T10:00:00+08:00` |
| 14  | `updated_at`              | 更新時間         | timestamptz |                | ISO 8601 日期時間                                                                                      | `2026-06-25T10:30:00+08:00` |

## `promotion_tiers`

| No. | Field name        | 中文名稱     | Type    | Key             | 規則 / 格式 / 範圍                                           | Example        |
| --- | ----------------- | ------------ | ------- | --------------- | ------------------------------------------------------------ | -------------- |
| 1   | `id`              | 優惠門檻編號 | TEXT    | PK              | 建議使用 `tier_` 加唯一後綴                                  | `tier_001`     |
| 2   | `activity_id`     | 團購活動編號 | TEXT    | FK, UNIQUE pair | References `group_buy_activities(id)`；與 `target_cups` 唯一 | `activity_001` |
| 3   | `target_cups`     | 目標杯數     | INTEGER | UNIQUE pair     | `> 0`                                                        | `20`           |
| 4   | `discount_percent` | 折扣百分比（2026-09-18 起取代 `discount_amount`） | INTEGER |                 | `1-99` 整數；代表折掉的百分比（例如 30 代表打 7 折／付原價 70%）；每筆訂單各自依自己的原價計算應付金額（`ceil(原價 * (100-discount_percent) / 100)`），不是固定金額也不是單杯折扣；應用層須驗證門檻杯數越高折扣百分比必須嚴格更好 | `30`          |
| 5   | `sort_order`      | 排序         | INTEGER |                 | 數字越小越前面                                               | `1`            |

## `activity_notices`

| No. | Field name    | 中文名稱     | Type    | Key | 規則 / 格式 / 範圍                    | Example                |
| --- | ------------- | ------------ | ------- | --- | ------------------------------------- | ---------------------- |
| 1   | `id`          | 活動備註編號 | TEXT    | PK  | 建議使用 `notice_` 加唯一後綴         | `notice_001`           |
| 2   | `activity_id` | 團購活動編號 | TEXT    | FK  | References `group_buy_activities(id)` | `activity_001`         |
| 3   | `content`     | 備註內容     | TEXT    |     | 必填                                  | `請於指定時間到店取貨` |
| 4   | `sort_order`  | 排序         | INTEGER |     | 數字越小越前面                        | `1`                    |

## `cart_drafts`

| No. | Field name                     | 中文名稱       | Type | Key               | 規則 / 格式 / 範圍                                | Example                     |
| --- | ------------------------------ | -------------- | ---- | ----------------- | ------------------------------------------------- | --------------------------- |
| 1   | `id`                           | 購物車草稿編號 | TEXT | PK                | 建議使用 `cart_` 加唯一後綴                       | `cart_001`                  |
| 2   | `user_id`                      | 使用者編號     | TEXT | FK, UNIQUE triple | References `users(id)`                            | `user_001`                  |
| 3   | `activity_id`                  | 團購活動編號   | TEXT | FK, UNIQUE triple | References `group_buy_activities(id)`             | `activity_001`              |
| 4   | `status`                       | 草稿狀態       | TEXT | UNIQUE triple     | `active`, `submitted`, `expired`, `cancelled`     | `active`                    |
| 5   | `fallback_purchase_preference` | 未達標購買偏好 | TEXT |                   | `decline_original_price`, `accept_original_price` | `accept_original_price`     |
| 6   | `created_at`                   | 建立時間       | timestamptz |                   | ISO 8601 日期時間                                 | `2026-06-25T10:00:00+08:00` |
| 7   | `updated_at`                   | 更新時間       | timestamptz |                   | ISO 8601 日期時間                                 | `2026-06-25T10:30:00+08:00` |

## `cart_draft_items`

| No. | Field name            | 中文名稱       | Type    | Key | 規則 / 格式 / 範圍                                | Example                     |
| --- | --------------------- | -------------- | ------- | --- | ------------------------------------------------- | --------------------------- |
| 1   | `id`                  | 購物車品項編號 | TEXT    | PK  | 建議使用 `cart_item_` 加唯一後綴                  | `cart_item_001`             |
| 2   | `cart_draft_id`       | 購物車草稿編號 | TEXT    | FK  | References `cart_drafts(id)`                      | `cart_001`                  |
| 3   | `menu_item_id`        | 菜單品項編號   | TEXT    | FK  | References `menu_items(id)`                       | `menu_item_001`             |
| 4   | `item_name_snapshot`  | 品項名稱快照   | TEXT    |     | 保存加入購物車時的顯示名稱                        | `白玉歐蕾`                  |
| 5   | `unit_price_snapshot` | 單價快照       | INTEGER |     | `>= 0`                                            | `70`                        |
| 6   | `quantity`            | 數量           | INTEGER |     | `> 0`                                             | `2`                         |
| 7   | `subtotal`            | 小計           | INTEGER |     | `>= 0`；單價加選項價差後乘以數量                  | `150`                       |
| 8   | `created_at`          | 建立時間       | timestamptz |     | ISO 8601 日期時間                                 | `2026-06-25T10:00:00+08:00` |
| 9   | `updated_at`          | 更新時間       | timestamptz |     | ISO 8601 日期時間                                 | `2026-06-25T10:30:00+08:00` |

## `cart_draft_item_customizations`

| No. | Field name                | 中文名稱             | Type    | Key | 規則 / 格式 / 範圍                                | Example                       |
| --- | ------------------------- | -------------------- | ------- | --- | ------------------------------------------------- | ----------------------------- |
| 1   | `id`                      | 購物車客製化編號     | TEXT    | PK  | 建議使用 `cart_item_customization_` 加唯一後綴    | `cart_item_customization_001` |
| 2   | `cart_draft_item_id`      | 購物車品項編號       | TEXT    | FK  | References `cart_draft_items(id)`                 | `cart_item_001`               |
| 3   | `customization_option_id` | 客製選項編號         | TEXT    | FK  | 原選項若被刪除可為 NULL                           | `option_001`                  |
| 4   | `option_type`             | 選項類型             | TEXT    |     | `sweetness`, `ice`, `topping`, `size`             | `topping`                     |
| 5   | `label_snapshot`          | 選項名稱快照         | TEXT    |     | 必填                                              | `珍珠`                        |
| 6   | `price_delta_snapshot`    | 加價金額快照         | INTEGER |     | 預設 `0`，可為正數                                | `10`                          |
| 7   | `sort_order`              | 排序                 | INTEGER |     | 數字越小越前面                                    | `1`                           |

## `orders`

| No. | Field name                     | 中文名稱       | Type    | Key       | 規則 / 格式 / 範圍                                                                | Example                     |
| --- | ------------------------------ | -------------- | ------- | --------- | --------------------------------------------------------------------------------- | --------------------------- |
| 1   | `id`                           | 訂單編號       | TEXT    | PK        | 建議使用 `order_` 加唯一後綴                                                      | `order_001`                 |
| 2   | `activity_id`                  | 團購活動編號   | TEXT    | FK, INDEX | References `group_buy_activities(id)`                                             | `activity_001`              |
| 3   | `customer_user_id`             | 顧客使用者編號 | TEXT    | FK, INDEX | References `users(id)`                                                            | `user_001`                  |
| 4   | `status`                       | 訂單狀態       | TEXT    |           | `draft`, `submitted`, `locked`, `cancelled`, `completed`                          | `submitted`                 |
| 5   | `fallback_purchase_preference` | 未達標購買偏好 | TEXT    |           | `decline_original_price`, `accept_original_price`                                 | `accept_original_price`     |
| 6   | `total_cups`                   | 總杯數         | INTEGER |           | `> 0`；應等於 order item quantity 加總                                            | `4`                         |
| 7   | `original_amount`              | 原始金額       | INTEGER |           | `>= 0`；預授權基準金額                                                            | `280`                       |
| 8   | `final_amount`                 | 最終金額       | INTEGER |           | 結算前可為 NULL                                                                   | `248`                       |
| 9   | `payment_status`               | 付款狀態       | TEXT    | INDEX     | `pending`, `authorized`, `captured`, `authorization_voided`, `failed`, `refunded` | `authorized`                |
| 10  | `authorization_status`         | 預授權狀態     | TEXT    |           | `pending`, `authorized`, `captured`, `authorization_voided`, `failed`             | `authorized`                |
| 11  | `merchant_acceptance_status`   | 店家接單狀態   | TEXT    |           | 舊候選欄位；最新規則不需店家逐筆確認，可考慮固定 `accepted` 或移除                | `accepted`                  |
| 12  | `pickup_status`                | 取貨狀態       | TEXT    |           | `not_ready`, `ready`, `picked_up`, `cancelled`, `expired`                         | `ready`                     |
| 13  | `submitted_at`                 | 送出時間       | timestamptz |           | ISO 8601 日期時間                                                                 | `2026-06-25T10:15:00+08:00` |
| 14  | `updated_at`                   | 更新時間       | timestamptz |           | ISO 8601 日期時間                                                                 | `2026-06-25T10:30:00+08:00` |
| 15  | `pickup_reminder_sent_at`      | 取餐提醒推播時間 | timestamptz |           | 可為 NULL＝尚未推播取餐截止提醒；僅 PostgreSQL（`010_order_pickup_reminder_postgres.sql`）。取餐排程以單一 `UPDATE ... WHERE pickup_reminder_sent_at IS NULL ... RETURNING` 認領訂單，認領即去重，每筆訂單最多提醒一次 | `2026-10-04T21:30:00+08:00` |

## `order_rule_consents`

此表保存顧客在進入 LINE Pay 預授權前對「取餐與逾期未取規則」的同意證據。PostgreSQL 定義位於 `005_order_rule_consents_postgres.sql`；SQLite schema 保留相容版本供隔離測試。

同意採追加歷史紀錄，不以可覆寫的單一 boolean 取代；一筆紀錄的存在即表示顧客曾同意該版本。後續規則版本變更時建立新紀錄，舊紀錄不得覆寫。

| No. | Field name             | 中文名稱         | Type | Key               | 規則 / 格式 / 範圍                                                                         | Example                     |
| --- | ---------------------- | ---------------- | ---- | ----------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| 1   | `id`                   | 規則同意紀錄編號 | TEXT | PK                | 使用 `rule-consent-` 加 UUID                                                               | `rule-consent-uuid`         |
| 2   | `order_id`             | 訂單編號         | TEXT | FK, INDEX, UNIQUE triple | References `orders(id)`；與 `rule_type`、`rule_version` 組成唯一鍵                    | `order_001`                 |
| 3   | `customer_user_id`     | 顧客使用者編號   | TEXT | FK, INDEX         | References `users(id)`；必須與該訂單的 `customer_user_id` 相同                             | `user_001`                  |
| 4   | `rule_type`            | 規則類型         | TEXT | UNIQUE triple     | 第一版固定為 `pickup_overdue`；與 `order_id`、`rule_version` 組成唯一鍵                    | `pickup_overdue`            |
| 5   | `rule_version`         | 規則版本         | TEXT | UNIQUE triple     | 必填；由 Backend 驗證為付款當下有效版本，不接受只由 Client 自行宣告                        | `v1.0`                      |
| 6   | `rule_content_snapshot` | 規則內容快照    | TEXT |                   | 必填；保存 Backend 當時提供的完整規則內容，規則日後修改不得影響既有紀錄                    | `取餐代碼自取餐開始起保留3小時……` |
| 7   | `consented_at`         | 規則同意時間     | timestamptz | INDEX | 必填；使用 Backend 真實伺服器時間，不採信 Client 本機時間，也不使用 dev 模擬業務時間 | `2026-08-10T02:30:00.000Z` |

## `order_action_idempotency`

| No. | Field name       | 中文名稱       | Type        | Key | 規則 / 格式 / 範圍                    | Example                     |
| --- | ---------------- | -------------- | ----------- | --- | ------------------------------------- | --------------------------- |
| 1   | `idempotency_key`| 冪等鍵         | text        | PK  | 防止相同訂單操作被重複執行            | `order-submit-uuid`         |
| 2   | `order_id`       | 訂單編號       | text        | FK  | References `orders(id)`               | `order_001`                 |
| 3   | `action_type`    | 操作類型       | text        |     | 必填；使用穩定 action name            | `submit_order`              |
| 4   | `actor_user_id`  | 操作者使用者編號 | text      | FK  | References `users(id)`                | `user_001`                  |
| 5   | `result_json`    | 操作結果       | jsonb       |     | 保存第一次操作的結果供重複請求重用    | `{"orderId":"order_001"}` |
| 6   | `created_at`     | 建立時間       | timestamptz |     | ISO 8601 日期時間                     | `2026-06-25T10:15:00+08:00` |

## `order_items`

| No. | Field name            | 中文名稱     | Type    | Key | 規則 / 格式 / 範圍                                | Example          |
| --- | --------------------- | ------------ | ------- | --- | ------------------------------------------------- | ---------------- |
| 1   | `id`                  | 訂單品項編號 | TEXT    | PK  | 建議使用 `order_item_` 加唯一後綴                 | `order_item_001` |
| 2   | `order_id`            | 訂單編號     | TEXT    | FK  | References `orders(id)`                           | `order_001`      |
| 3   | `menu_item_id`        | 菜單品項編號 | TEXT    | FK  | 原 menu item 被刪除時可為 NULL                    | `menu_item_001`  |
| 4   | `item_name_snapshot`  | 品項名稱快照 | TEXT    |     | 必填                                              | `白玉歐蕾`       |
| 5   | `quantity`            | 數量         | INTEGER |     | `> 0`                                             | `2`              |
| 6   | `unit_price_snapshot` | 單價快照     | INTEGER |     | `>= 0`                                            | `75`             |
| 7   | `subtotal`            | 品項小計     | INTEGER |     | `>= 0`；單價加選項價差後乘以數量                  | `150`            |

## `order_item_customizations`

| No. | Field name                | 中文名稱         | Type    | Key | 規則 / 格式 / 範圍                              | Example                        |
| --- | ------------------------- | ---------------- | ------- | --- | ----------------------------------------------- | ------------------------------ |
| 1   | `id`                      | 訂單客製化編號   | TEXT    | PK  | 建議使用 `order_item_customization_` 加唯一後綴 | `order_item_customization_001` |
| 2   | `order_item_id`           | 訂單品項編號     | TEXT    | FK  | References `order_items(id)`                    | `order_item_001`               |
| 3   | `customization_option_id` | 客製選項編號     | TEXT    | FK  | 原選項若被刪除可為 NULL                         | `option_001`                   |
| 4   | `option_type`             | 選項類型         | TEXT    |     | `sweetness`, `ice`, `topping`, `size`           | `sweetness`                    |
| 5   | `label_snapshot`          | 選項名稱快照     | TEXT    |     | 必填                                            | `微糖`                         |
| 6   | `price_delta_snapshot`    | 加價金額快照     | INTEGER |     | 預設 `0`，可為正數                              | `0`                            |
| 7   | `sort_order`              | 排序             | INTEGER |     | 數字越小越前面                                  | `1`                            |

## `order_revisions`

用途：保存已完成預授權訂單的待確認修改版本。新 revision 需重新預授權；成功後才套用到原訂單，失敗或取消時原訂單維持有效。

| No. | Field name                              | 中文名稱           | Type    | Key       | 規則 / 格式 / 範圍                                                              | Example                     |
| --- | --------------------------------------- | ------------------ | ------- | --------- | -------------------------------------------------------------------------------- | --------------------------- |
| 1   | `id`                                    | 訂單修改版本編號   | TEXT    | PK        | 建議使用 `order_revision_` 加唯一後綴                                            | `order_revision_001`        |
| 2   | `order_id`                              | 原訂單編號         | TEXT    | FK, INDEX | References `orders(id)`                                                          | `order_001`                 |
| 3   | `status`                                | 修改版本狀態       | TEXT    | INDEX     | `pending_authorization`, `applied`, `failed`, `cancelled`                        | `pending_authorization`     |
| 4   | `original_payment_authorization_id`     | 原預授權編號       | TEXT    | FK        | 可為 NULL；指向被替換前的有效 authorization                                      | `pay_auth_old_001`          |
| 5   | `replacement_payment_authorization_id`  | 替換預授權編號     | TEXT    | FK        | 可為 NULL；新 authorization 成功後填入                                           | `pay_auth_new_001`          |
| 6   | `fallback_purchase_preference`          | 未達標購買偏好     | TEXT    |           | `decline_original_price`, `accept_original_price`                                 | `accept_original_price`     |
| 7   | `previous_total_cups`                   | 原總杯數           | INTEGER |           | `> 0`；建立 revision 時的原訂單杯數                                              | `2`                         |
| 8   | `previous_original_amount`              | 原訂單原始金額     | INTEGER |           | `>= 0`；建立 revision 時的原訂單原始金額                                         | `140`                       |
| 9   | `total_cups`                            | 修改後總杯數       | INTEGER |           | `> 0`；revision item quantity 加總                                                | `3`                         |
| 10  | `original_amount`                       | 修改後原始金額     | INTEGER |           | `>= 0`；重新預授權基準金額                                                       | `210`                       |
| 11  | `failure_reason`                        | 失敗原因           | TEXT    |           | 可為 NULL；新預授權、容量檢查或 provider 流程失敗時保存                           | `authorization_cancelled`   |
| 12  | `created_at`                            | 建立時間           | timestamptz |           | ISO 8601 日期時間                                                                | `2026-06-25T10:20:00+08:00` |
| 13  | `updated_at`                            | 更新時間           | timestamptz |           | ISO 8601 日期時間                                                                | `2026-06-25T10:25:00+08:00` |
| 14  | `applied_at`                            | 套用時間           | timestamptz |           | 可為 NULL；新預授權成功並套用到原訂單時填入                                      | `2026-06-25T10:26:00+08:00` |
| 15  | `cancelled_at`                          | 取消時間           | timestamptz |           | 可為 NULL；顧客取消 revision 或流程取消時填入                                     | `2026-06-25T10:24:00+08:00` |

## `order_revision_items`

| No. | Field name            | 中文名稱             | Type    | Key | 規則 / 格式 / 範圍                                | Example                    |
| --- | --------------------- | -------------------- | ------- | --- | ------------------------------------------------- | -------------------------- |
| 1   | `id`                  | 修改版本品項編號     | TEXT    | PK  | 建議使用 `order_revision_item_` 加唯一後綴         | `order_revision_item_001`  |
| 2   | `order_revision_id`   | 訂單修改版本編號     | TEXT    | FK  | References `order_revisions(id)`                  | `order_revision_001`       |
| 3   | `menu_item_id`        | 菜單品項編號         | TEXT    | FK  | 原 menu item 被刪除時可為 NULL                    | `menu_item_001`            |
| 4   | `item_name_snapshot`  | 品項名稱快照         | TEXT    |     | 必填                                              | `白玉歐蕾`                 |
| 5   | `quantity`            | 數量                 | INTEGER |     | `> 0`                                             | `3`                        |
| 6   | `unit_price_snapshot` | 單價快照             | INTEGER |     | `>= 0`                                            | `70`                       |
| 7   | `subtotal`            | 品項小計             | INTEGER |     | `>= 0`；單價加選項價差後乘以數量                  | `210`                      |

## `order_revision_item_customizations`

| No. | Field name                | 中文名稱                 | Type    | Key | 規則 / 格式 / 範圍                              | Example                                  |
| --- | ------------------------- | ------------------------ | ------- | --- | ----------------------------------------------- | ---------------------------------------- |
| 1   | `id`                      | 修改版本客製化編號       | TEXT    | PK  | 建議使用 `order_revision_item_customization_` 加唯一後綴 | `order_revision_item_customization_001` |
| 2   | `order_revision_item_id`  | 修改版本品項編號         | TEXT    | FK  | References `order_revision_items(id)`           | `order_revision_item_001`                |
| 3   | `customization_option_id` | 客製選項編號             | TEXT    | FK  | 原選項若被刪除可為 NULL                         | `option_001`                             |
| 4   | `option_type`             | 選項類型                 | TEXT    |     | `sweetness`, `ice`, `topping`, `size`           | `ice`                                    |
| 5   | `label_snapshot`          | 選項名稱快照             | TEXT    |     | 必填                                            | `少冰`                                   |
| 6   | `price_delta_snapshot`    | 加價金額快照             | INTEGER |     | 預設 `0`，可為正數                              | `0`                                      |
| 7   | `sort_order`              | 排序                     | INTEGER |     | 數字越小越前面                                  | `2`                                      |

## `payment_authorizations`

| No. | Field name                  | 中文名稱            | Type    | Key       | 規則 / 格式 / 範圍                                                    | Example                     |
| --- | --------------------------- | ------------------- | ------- | --------- | --------------------------------------------------------------------- | --------------------------- |
| 1   | `id`                        | 預授權編號          | TEXT    | PK        | 建議使用 `pay_auth_` 加唯一後綴                                       | `pay_auth_001`              |
| 2   | `order_id`                  | 訂單編號            | TEXT    | FK, INDEX | References `orders(id)`                                               | `order_001`                 |
| 3   | `order_revision_id`         | 訂單修改版本編號    | TEXT    | FK        | 可為 NULL；修改訂單重新預授權時使用                                   | `order_revision_001`        |
| 4   | `provider`                  | 金流服務商          | TEXT    |           | `line_pay`, `mock_line_pay`（`ecpay`/`mock_ecpay` 曾於 2026-08-05 新增，隨 ECPay 移除已於 2026-08-27 從允許值移除） | `line_pay`                  |
| 5   | `payment_flow`              | 付款流程            | TEXT    |           | `authorization`, `direct_repayment`                                   | `direct_repayment`          |
| 6   | `status`                    | 付款處理狀態        | TEXT    |           | `pending`, `authorized`, `captured`, `authorization_voided`, `failed` | `authorized`                |
| 7   | `original_amount`           | 原始金額            | INTEGER |           | `>= 0`                                                                | `280`                       |
| 8   | `authorized_amount`         | 預授權或付款金額    | INTEGER |           | `>= 0`                                                                | `280`                       |
| 9   | `provider_authorization_id` | Provider 交易編號   | TEXT    |           | Mock flow 可為 NULL                                                   | `linepay-auth-123`          |
| 10  | `expires_at`                | 預授權到期時間      | timestamptz |           | 可為 NULL；LINE Pay 分離式請款時取自 `authorizationExpireDate`          | `2026-06-26T10:00:00+08:00` |
| 11  | `authorized_at`             | 授權或付款成功時間  | timestamptz |           | 成功前可為 NULL                                                       | `2026-06-25T10:16:00+08:00` |
| 12  | `voided_at`                 | 取消預授權時間      | timestamptz |           | void 前可為 NULL                                                      | `2026-06-25T15:30:00+08:00` |
| 13  | `failure_reason`            | 失敗原因            | TEXT    |           | 可為 NULL                                                             | `provider_timeout`          |
| 14  | `created_at`                | 建立時間            | timestamptz |           | ISO 8601 日期時間                                                     | `2026-06-25T10:15:00+08:00` |
| 15  | `updated_at`                | 更新時間            | timestamptz |           | ISO 8601 日期時間                                                     | `2026-06-25T10:16:00+08:00` |

## `payment_captures`

| No. | Field name                 | 中文名稱          | Type    | Key | 規則 / 格式 / 範圍                       | Example                      |
| --- | -------------------------- | ----------------- | ------- | --- | ---------------------------------------- | ---------------------------- |
| 1   | `id`                       | 請款編號          | TEXT    | PK  | 建議使用 `pay_capture_` 加唯一後綴       | `pay_capture_001`            |
| 2   | `payment_authorization_id` | 預授權編號        | TEXT    | FK  | References `payment_authorizations(id)`  | `pay_auth_001`               |
| 3   | `order_id`                 | 訂單編號          | TEXT    | FK  | References `orders(id)`                  | `order_001`                  |
| 4   | `status`                   | 請款狀態          | TEXT    |     | `pending`, `captured`, `failed`          | `captured`                   |
| 5   | `final_amount`             | 最終金額          | INTEGER |     | `>= 0`                                   | `248`                        |
| 6   | `capture_amount`           | 請款金額          | INTEGER |     | `>= 0`；不可超過 authorized amount       | `248`                        |
| 7   | `released_amount`          | 釋放金額          | INTEGER |     | `>= 0`；預授權金額減請款金額             | `32`                         |
| 8   | `provider_capture_id`      | Provider 請款編號 | TEXT    |     | Mock flow 可為 NULL                      | `linepay-capture-123`        |
| 9   | `captured_at`              | 請款時間          | timestamptz |     | 請款前可為 NULL                          | `2026-06-25T15:31:00+08:00`  |
| 10  | `failure_reason`           | 失敗原因          | TEXT    |     | 可為 NULL                                | `provider_timeout`           |
| 11  | `attempt_number`           | 請款嘗試序號      | INTEGER |     | 從 `1` 開始；自動請款最多 `3` 次          | `2`                          |
| 12  | `retryable`                | 可否自動重試      | boolean |     | `true` = 可重試，`false` = 不可重試        | `true`                       |
| 13  | `next_retry_at`            | 下次重試時間      | timestamptz |     | 可重試失敗後 30 秒；否則為 NULL           | `2026-06-25T15:30:30+08:00`  |
| 14  | `created_at`               | 建立時間          | timestamptz |     | ISO 8601 日期時間                        | `2026-06-25T15:30:00+08:00`  |
| 15  | `updated_at`               | 更新時間          | timestamptz |     | ISO 8601 日期時間                        | `2026-06-25T15:31:00+08:00`  |

## `payment_refunds`

| No. | Field name                 | 中文名稱          | Type    | Key    | 規則 / 格式 / 範圍                       | Example                     |
| --- | -------------------------- | ----------------- | ------- | ------ | ---------------------------------------- | --------------------------- |
| 1   | `id`                       | 退款編號          | TEXT    | PK     | 建議使用 `pay_refund_` 加唯一後綴        | `pay_refund_001`            |
| 2   | `payment_capture_id`       | 請款編號          | TEXT    | FK     | References `payment_captures(id)`        | `pay_capture_001`           |
| 3   | `payment_authorization_id` | 預授權編號        | TEXT    | FK     | References `payment_authorizations(id)`  | `pay_auth_001`              |
| 4   | `order_id`                 | 訂單編號          | TEXT    | FK     | References `orders(id)`                  | `order_001`                 |
| 5   | `provider`                 | 金流服務商        | TEXT    |        | `line_pay`, `mock_line_pay` | `line_pay`                  |
| 6   | `status`                   | 退款狀態          | TEXT    |        | `pending`, `refunded`, `failed`          | `refunded`                  |
| 7   | `refund_amount`            | 退款金額          | INTEGER |        | `> 0`，不得超過該請款剩餘可退款金額       | `248`                       |
| 8   | `provider_refund_id`       | Provider 退款編號 | TEXT    |        | 成功前可為 NULL                          | `linepay-refund-123`        |
| 9   | `idempotency_key`          | 冪等鍵            | TEXT    | UNIQUE | 防止同一退款要求被重複執行               | `refund-order-001-full`     |
| 10  | `refunded_at`              | 退款完成時間      | timestamptz |        | 成功前可為 NULL                          | `2026-06-25T16:00:00+08:00` |
| 11  | `failure_reason`           | 失敗原因          | TEXT    |        | 可為 NULL                                | `provider_timeout`          |
| 12  | `created_at`               | 建立時間          | timestamptz |        | ISO 8601 日期時間                        | `2026-06-25T15:59:00+08:00` |
| 13  | `updated_at`               | 更新時間          | timestamptz |        | ISO 8601 日期時間                        | `2026-06-25T16:00:00+08:00` |

## `refund_requests`

2026-08-04 新增。保存商家對已請款訂單提出的退款申請，供營運審核；核准時才實際呼叫 provider 並寫入一筆 `payment_refunds`，駁回不呼叫 provider。同一筆 `payment_capture_id` 同時只允許一筆 `status = 'pending'` 的申請（partial unique index）。

| No. | Field name                     | 中文名稱               | Type    | Key    | 規則 / 格式 / 範圍                       | Example                     |
| --- | ------------------------------- | ---------------------- | ------- | ------ | ---------------------------------------- | ---------------------------- |
| 1   | `id`                            | 退款申請編號            | TEXT    | PK     | 建議使用 `refund-request-` 加唯一後綴    | `refund-request-001`         |
| 2   | `order_id`                      | 訂單編號                | TEXT    | FK     | References `orders(id)`                  | `order_001`                  |
| 3   | `payment_capture_id`            | 請款編號                | TEXT    | FK     | References `payment_captures(id)`        | `pay_capture_001`            |
| 4   | `store_id`                      | 店家編號                | TEXT    | FK     | References `stores(id)`                  | `store_001`                  |
| 5   | `requested_by_user_id`          | 提出申請的商家使用者    | TEXT    | FK     | References `users(id)`                   | `user-merchant-001`          |
| 6   | `requested_amount`              | 申請退款金額            | INTEGER |        | `> 0`                                    | `248`                        |
| 7   | `reason`                        | 申請原因                | TEXT    |        | 必填                                      | `顧客反映飲品品質異常`       |
| 8   | `status`                        | 申請狀態                | TEXT    |        | `pending`, `approved`, `rejected`        | `pending`                    |
| 9   | `idempotency_key`               | 冪等鍵                  | TEXT    | UNIQUE | 可為 NULL                                | `refund-request-order-001`   |
| 10  | `reviewed_by_user_id`           | 審核的營運使用者        | TEXT    | FK     | 審核前可為 NULL；References `users(id)`  | `user-admin-001`             |
| 11  | `reviewed_at`                   | 審核時間                | timestamptz |        | 審核前可為 NULL                          | `2026-08-04T16:00:00+08:00`  |
| 12  | `rejection_reason`              | 駁回原因                | TEXT    |        | 僅駁回時填寫                             | `已改為重新製作`             |
| 13  | `resulting_payment_refund_id`   | 核准後對應的退款編號    | TEXT    | FK     | 核准前可為 NULL；References `payment_refunds(id)` | `pay_refund_001`   |
| 14  | `created_at`                    | 建立時間                | timestamptz |        | ISO 8601 日期時間                        | `2026-08-04T15:59:00+08:00`  |
| 15  | `updated_at`                    | 更新時間                | timestamptz |        | ISO 8601 日期時間                        | `2026-08-04T16:00:00+08:00`  |

## `merchant_applications`

2026-09-10 新增。保存商家自助申請的資料，供管理員在 `/admin/merchant-applications` 審核；核准時才在同一個交易裡建立 `merchants`／`stores`／`merchant_users`／`user_roles`（若申請人是全新的 Google 帳號，一併建立 `users`）。這是這個專案第一個會在執行期間（不是一次性 seed SQL）建立商家資料的路徑。緯度／經度不存在這張表，由管理員審核時直接手動填進 `stores.latitude`／`stores.longitude`（無 Geocoding 整合）。同一個 `applicant_firebase_uid` 同時只允許一筆 `status = 'pending'` 的申請（partial unique index）。

| No. | Field name                | 中文名稱             | Type    | Key    | 規則 / 格式 / 範圍                          | Example                       |
| --- | -------------------------- | -------------------- | ------- | ------ | -------------------------------------------- | ------------------------------ |
| 1   | `id`                        | 申請編號              | TEXT    | PK     | 建議使用 `merchant-application-` 加唯一後綴  | `merchant-application-001`     |
| 2   | `applicant_firebase_uid`    | 申請人 Firebase UID   | TEXT    |        | 必填；申請時驗證 Firebase ID token 取得      | `firebase-uid-abc123`          |
| 3   | `applicant_email`           | 申請人 Email          | TEXT    |        | 可為 NULL                                    | `owner@example.com`            |
| 4   | `applicant_display_name`    | 申請人顯示名稱        | TEXT    |        | 可為 NULL                                    | `王小明`                        |
| 5   | `contact_phone`             | 聯絡電話              | TEXT    |        | 必填                                          | `04-1234-5678`                 |
| 6   | `store_name`                | 申請店名              | TEXT    |        | 必填                                          | `青山手作茶 中科店`             |
| 7   | `address`                   | 申請地址（純文字）    | TEXT    |        | 必填；不含經緯度                             | `台中市北區三民路三段...`      |
| 8   | `status`                    | 申請狀態              | TEXT    |        | `pending`, `approved`, `rejected`            | `pending`                      |
| 9   | `reviewed_by_user_id`       | 審核的管理員          | TEXT    | FK     | 審核前可為 NULL；References `users(id)`      | `user-admin-001`               |
| 10  | `reviewed_at`                | 審核時間              | timestamptz |    | 審核前可為 NULL                              | `2026-09-10T16:00:00+08:00`    |
| 11  | `rejection_reason`           | 駁回原因              | TEXT    |        | 僅駁回時填寫                                 | `店家資訊不完整`               |
| 12  | `resulting_merchant_id`      | 核准後對應的商家編號  | TEXT    | FK     | 核准前可為 NULL；References `merchants(id)`  | `merchant-001`                 |
| 13  | `resulting_store_id`         | 核准後對應的門市編號  | TEXT    | FK     | 核准前可為 NULL；References `stores(id)`     | `store-001`                    |
| 14  | `resulting_user_id`          | 核准後對應的使用者編號| TEXT    | FK     | 核准前可為 NULL；References `users(id)`      | `user-001`                     |
| 15  | `created_at`                 | 建立時間              | timestamptz |    | ISO 8601 日期時間                            | `2026-09-10T15:59:00+08:00`    |
| 16  | `updated_at`                 | 更新時間              | timestamptz |    | ISO 8601 日期時間                            | `2026-09-10T16:00:00+08:00`    |

## `payment_provider_events`

| No. | Field name        | 中文名稱          | Type | Key    | 規則 / 格式 / 範圍                         | Example                     |
| --- | ----------------- | ----------------- | ---- | ------ | ------------------------------------------ | --------------------------- |
| 1   | `id`              | Provider 事件編號 | TEXT | PK     | 建議使用 `pay_event_` 加唯一後綴           | `pay_event_001`             |
| 2   | `provider`        | 金流服務商        | TEXT |        | 必填                                       | `line_pay`                  |
| 3   | `resource_type`   | 資源類型          | TEXT |        | `authorization`, `capture`, `refund`       | `authorization`             |
| 4   | `resource_id`     | 資源編號          | TEXT |        | Provider 或本地資源識別                    | `pay_auth_001`              |
| 5   | `event_type`      | 事件類型          | TEXT |        | Provider event name                        | `authorization.succeeded`   |
| 6   | `idempotency_key` | 冪等鍵            | TEXT | UNIQUE | 防止重複處理                               | `evt_abc123`                |
| 7   | `payload_json`    | 原始事件內容      | jsonb |        | Provider 回傳事件的 JSON 內容              | `{"status":"authorized"}`   |
| 8   | `received_at`     | 接收時間          | timestamptz |        | ISO 8601 日期時間                          | `2026-06-25T10:16:00+08:00` |
| 9   | `processed_at`    | 處理時間          | timestamptz |        | 處理前可為 NULL                            | `2026-06-25T10:16:01+08:00` |

## `payment_reliability_jobs`

| No. | Field name       | 中文名稱       | Type        | Key | 規則 / 格式 / 範圍                                                        | Example                     |
| --- | ---------------- | -------------- | ----------- | --- | ------------------------------------------------------------------------- | --------------------------- |
| 1   | `id`             | 工作編號       | text        | PK  | 系統產生的唯一識別碼                                                      | `payment-job-001`           |
| 2   | `job_type`       | 工作類型       | text        |     | `reconcile_line_pay_request`, `settle_group_buy_activity`                 | `reconcile_line_pay_request`|
| 3   | `resource_type`  | 資源類型       | text        |     | `payment_authorization`, `activity`                                       | `payment_authorization`     |
| 4   | `resource_id`    | 資源編號       | text        |     | 對應付款授權或團購活動編號                                                | `pay_auth_001`              |
| 5   | `status`         | 工作狀態       | text        |     | `queued`, `running`, `retry_wait`, `succeeded`, `failed`, `cancelled`      | `queued`                    |
| 6   | `payload_json`   | 工作資料       | jsonb       |     | 預設空 JSON                                                              | `{"orderId":"order_001"}` |
| 7   | `attempt_count`  | 已嘗試次數     | integer     |     | `>= 0`                                                                   | `0`                         |
| 8   | `max_attempts`   | 最大嘗試次數   | integer     |     | `> 0`；預設 `20`                                                         | `20`                        |
| 9   | `run_after`      | 最早執行時間   | timestamptz | INDEX | 到達此時間後才可被 worker 取得                                           | `2026-06-25T10:16:00+08:00` |
| 10  | `locked_by`      | 鎖定者         | text        |     | 未被 worker 取得時可為 NULL                                               | `worker-01`                 |
| 11  | `locked_until`   | 鎖定期限       | timestamptz | INDEX | 租約到期後可由其他 worker 接手                                            | `2026-06-25T10:16:30+08:00` |
| 12  | `last_error_json`| 最近錯誤       | jsonb       |     | 尚未失敗時可為 NULL                                                       | `{"code":"timeout"}`     |
| 13  | `alert_required` | 是否需要告警   | boolean     |     | 預設 `false`                                                             | `false`                     |
| 14  | `created_at`     | 建立時間       | timestamptz |     | ISO 8601 日期時間                                                        | `2026-06-25T10:15:00+08:00` |
| 15  | `updated_at`     | 更新時間       | timestamptz |     | ISO 8601 日期時間                                                        | `2026-06-25T10:15:30+08:00` |
| 16  | `completed_at`   | 完成時間       | timestamptz |     | 完成前可為 NULL                                                          | `2026-06-25T10:16:00+08:00` |

## `operation_locks`

| No. | Field name    | 中文名稱     | Type        | Key | 規則 / 格式 / 範圍                         | Example                     |
| --- | ------------- | ------------ | ----------- | --- | ------------------------------------------ | --------------------------- |
| 1   | `lock_key`    | 鎖定鍵       | text        | PK  | 對應需要避免重複執行的業務資源             | `order:order_001:payment-lifecycle` |
| 2   | `owner_id`    | 鎖定持有者   | text        |     | 目前持有租約的 worker 編號                 | `worker-01`                 |
| 3   | `locked_until`| 鎖定期限     | timestamptz |     | 租約到期後可被其他 worker 接手             | `2026-06-25T10:16:30+08:00` |
| 4   | `created_at`  | 建立時間     | timestamptz |     | ISO 8601 日期時間                          | `2026-06-25T10:15:00+08:00` |
| 5   | `updated_at`  | 更新時間     | timestamptz |     | ISO 8601 日期時間                          | `2026-06-25T10:15:30+08:00` |

## `activity_settlements`

第 9-10 項由 PostgreSQL `003_activity_settlement_discount_snapshot_postgres.sql` 加入；2026-09-18 `008_percentage_discount_postgres.sql` 把固定金額折扣改成百分比折扣，移除了 `discount_per_cup`／`allocated_discount_amount`／`undistributed_discount_amount`（百分比折扣逐筆訂單計算，沒有「一包總額分攤」這個概念），`discount_amount` 改名 `total_discount_amount`，並新增 `discount_percent`。

| No. | Field name        | 中文名稱         | Type    | Key        | 規則 / 格式 / 範圍                    | Example                     |
| --- | ----------------- | ---------------- | ------- | ---------- | ------------------------------------- | --------------------------- |
| 1   | `id`              | 活動結算編號     | TEXT    | PK         | 建議使用 `settlement_` 加唯一後綴     | `settlement_001`            |
| 2   | `activity_id`     | 團購活動編號     | TEXT    | FK, UNIQUE | 每個 activity 一筆 settlement         | `activity_001`              |
| 3   | `outcome`         | 結算結果         | TEXT    |            | `qualified`, `failed`, `cancelled`    | `qualified`                 |
| 4   | `authorized_cups` | 預授權杯數       | INTEGER |            | `>= 0`；結算時的權威杯數              | `25`                        |
| 5   | `applied_tier_id` | 適用優惠門檻編號 | TEXT    | FK         | 未達標或取消時可為 NULL               | `tier_002`                  |
| 6   | `total_discount_amount` | 折扣總金額（衍生值） | INTEGER |            | `>= 0`；結算後把每筆訂單自己算出的折扣加總得出，不是預先定義的一包金額 | `13`                       |
| 7   | `discount_percent` | 適用折扣百分比 | INTEGER | | 未達標或取消時為 NULL；否則 `1-99` 整數 | `21` |
| 8   | `discount_funder` | 優惠出資方 | TEXT | | `merchant` 或 `platform` | `merchant` |
| 9   | `calculation_version` | 折扣計算版本 | TEXT | | 百分比制版本為 `percentage_v1`（舊制 `floor_per_cup_v1` 僅存在於 2026-09-18 前的歷史結算紀錄） | `percentage_v1` |
| 10  | `settled_at`      | 結算時間         | timestamptz |            | ISO 8601 日期時間                     | `2026-06-25T15:30:00+08:00` |
| 11  | `reason`          | 結算原因         | TEXT    |            | 可為 NULL                             | `deadline_reached`          |

## `pickup_credentials`

| No. | Field name                          | 中文名稱       | Type    | Key        | 規則 / 格式 / 範圍                          | Example                     |
| --- | ----------------------------------- | -------------- | ------- | ---------- | ------------------------------------------- | --------------------------- |
| 1   | `id`                                | 取貨憑證編號   | TEXT    | PK         | 建議使用 `pickup_cred_` 加唯一後綴          | `pickup_cred_001`           |
| 2   | `order_id`                          | 訂單編號       | TEXT    | FK, UNIQUE | 每個 order 一筆 credential                  | `order_001`                 |
| 3   | `pickup_code`                       | 取貨代碼       | TEXT    |            | 必填；六位數字                              | `792401`                    |
| 4   | `visible_after_merchant_acceptance` | 接單後才顯示   | boolean |            | 現行資料欄位；預設 `true`                    | `true`                      |
| 5   | `expires_at`                        | 憑證到期時間     | timestamptz | INDEX      | 依取餐時間規則計算；到期後訂單應移至歷史訂單        | `2026-06-25T18:30:00+08:00` |
| 6   | `expired_at`                        | 實際逾期處理時間 | timestamptz |            | 可為 NULL；系統實際改為 `expired` 的時間           | `2026-06-25T18:30:05+08:00` |
| 7   | `redeemed_at`                       | 核銷時間         | timestamptz |            | 核銷前可為 NULL                                    | `2026-06-25T17:05:00+08:00` |
| 8   | `redeemed_by_user_id`               | 核銷者使用者編號 | TEXT        | FK         | 核銷前可為 NULL；References `users(id)`             | `user_merchant_001`         |
| 9   | `created_at`                        | 建立時間         | timestamptz |            | ISO 8601 日期時間                                    | `2026-06-25T15:40:00+08:00` |

## `status_history`

| No. | Field name      | 中文名稱         | Type | Key        | 規則 / 格式 / 範圍                                     | Example                     |
| --- | --------------- | ---------------- | ---- | ---------- | ------------------------------------------------------ | --------------------------- |
| 1   | `id`            | 狀態歷程編號     | TEXT | PK         | 建議使用 `status_history_` 加唯一後綴                  | `status_history_001`        |
| 2   | `resource_type` | 資源類型         | TEXT | INDEX pair | `activity`, `order`, `payment_authorization`, `pickup` | `order`                     |
| 3   | `resource_id`   | 資源編號         | TEXT | INDEX pair | 依 `resource_type` 指向對應資源                        | `order_001`                 |
| 4   | `from_status`   | 原狀態           | TEXT |            | 初始建立時可為 NULL                                    | `submitted`                 |
| 5   | `to_status`     | 新狀態           | TEXT |            | 必填                                                   | `locked`                    |
| 6   | `reason`        | 原因             | TEXT |            | 可為 NULL                                              | `deadline_lock`             |
| 7   | `actor_user_id` | 操作者使用者編號 | TEXT | FK         | 系統操作時可為 NULL                                    | `user_admin_001`            |
| 8   | `created_at`    | 建立時間         | timestamptz |            | ISO 8601 日期時間                                      | `2026-06-25T15:30:00+08:00` |

## `audit_logs`

| No. | Field name      | 中文名稱         | Type | Key        | 規則 / 格式 / 範圍                         | Example                     |
| --- | --------------- | ---------------- | ---- | ---------- | ------------------------------------------ | --------------------------- |
| 1   | `id`            | 稽核紀錄編號     | TEXT | PK         | 建議使用 `audit_` 加唯一後綴               | `audit_001`                 |
| 2   | `actor_user_id` | 操作者使用者編號 | TEXT | FK         | 系統操作時可為 NULL                        | `user_admin_001`            |
| 3   | `action_type`   | 操作類型         | TEXT |            | 必填；使用穩定 action names                | `admin_cancel_activity`     |
| 4   | `resource_type` | 資源類型         | TEXT | INDEX pair | 必填                                       | `activity`                  |
| 5   | `resource_id`   | 資源編號         | TEXT | INDEX pair | 必填                                       | `activity_001`              |
| 6   | `metadata_json` | 補充資料         | jsonb |            | 操作相關的 JSON 補充資料                   | `{"reason":"test cancel"}`  |
| 7   | `created_at`    | 建立時間         | timestamptz |            | ISO 8601 日期時間                          | `2026-06-25T15:35:00+08:00` |

## `push_tokens`

由 `009_push_tokens_postgres.sql` 加入，2026-09-30 決定：後端直接呼叫 Expo push service 發送顧客端推播（開團成功、可以領飲料），見 `docs/open-questions.md`「一致性與營運」表。Identity 是 `expo_push_token`（裝置）不是 `(user_id, expo_push_token)`：同一裝置換登入帳號時，upsert 把整筆改指向新的 `user_id`，不會留下指向舊使用者的重複紀錄。

| No. | Field name        | 中文名稱     | Type        | Key        | 規則 / 格式 / 範圍                              | Example                            |
| --- | ----------------- | ------------ | ----------- | ---------- | ------------------------------------------------ | ----------------------------------- |
| 1   | `id`              | 推播裝置編號 | TEXT        | PK         | 建議使用 `push-token-` 加唯一後綴               | `push-token-001`                    |
| 2   | `user_id`         | 使用者編號   | TEXT        | FK         | References `users(id)`；換綁時覆蓋              | `user_customer_001`                 |
| 3   | `expo_push_token` | Expo 推播權杖 | TEXT       | UNIQUE     | 裝置身分本身；upsert 的衝突鍵                   | `ExponentPushToken[xxxxxxxxxxxxxx]` |
| 4   | `platform`        | 平台         | TEXT        |            | `ios` 或 `android`                              | `android`                           |
| 5   | `created_at`      | 建立時間     | timestamptz |            | ISO 8601 日期時間                                | `2026-09-30T15:30:00+08:00`         |
| 6   | `updated_at`      | 更新時間     | timestamptz |            | 每次 upsert（含換綁使用者）都會更新              | `2026-09-30T15:35:00+08:00`         |

## 進度與未決事項

本文件只維護 PostgreSQL 欄位定義，不維護功能完成度。現行進度以 `PROGRESS.md` 為準；尚待產品決策的資料庫議題以 `docs/open-questions.md` 為準。
