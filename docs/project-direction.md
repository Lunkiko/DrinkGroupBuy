# 專案方向

最後更新：2026-10-21

## 產品定位

DrinkGroupBuy 是 Android-first 的手搖飲團購 App，讓顧客探索附近店家與團購、選購飲品、完成付款授權並追蹤取餐；店家則管理菜單、建立團購、查看有效訂單及核銷取餐。系統仍在開發階段，尚未形成正式 production release。

第一階段正式平台是 Android。Expo Web 只用於本機開發預覽；iOS 不在第一階段驗收範圍。

## 使用者與權限

- 顧客：瀏覽活動、點餐、付款授權、修改或取消未鎖定訂單、查看進度與取餐憑證。
- 店家：管理所屬門市菜單與團購、查看訂單、標記可取餐、核銷取餐及對自己門市已請款的訂單直接退款。
- 營運／補救身份：處理活動取消、手動結算與既有的待審退款申請等敏感補救操作；不是第一階段正式 App 的一般角色。
- 正式登入方向是 Firebase Auth + Google Login。Mobile 只取得 Firebase ID token；角色與門市權限由 Backend 根據 `users`、`user_roles`、`merchant_users` 判斷，不由前端選擇。
- 同一個一般帳號同時只啟用顧客或商家其中一種介面。管理員可在 `/admin/accounts` 切換；切換只停用另一角色及商家登入關聯，不刪除 `users`、顧客訂單／個人資料、商家、門市或歷史紀錄。首次成為商家仍需先完成商家申請審核，建立門市關聯後才能切換。
- `AUTH_DEV_MODE`／`EXPO_PUBLIC_AUTH_MODE=dev` 的身份切換器只供本機開發，production 不得啟用。

## 核心流程

1. 店家維護門市菜單，建立團購草稿並發布為 `recruiting`。
2. 顧客從地圖或列表選擇活動，依該店目前可販售菜單建立購物車；團購不複製一份獨立的活動菜單。
3. Backend 在送單或改單時重新驗證店家歸屬、供應狀態、客製化規則、容量與價格，並保存訂單快照。
4. 顧客完成 LINE Pay 付款授權後才計入有效杯數；授權成功不等同正式扣款。
5. 截止時系統以有效授權訂單計算最終級距，依結果 capture 或 void；扣款成功的訂單才進入製作。
6. 店家標記可取餐後，顧客出示取餐憑證，店家核銷；逾期狀態與是否退款分開處理。

完整的目標使用者流程以 `docs/final-product-user-flow.md` 為準；付款細節以 `docs/payment-rules-and-flow.md` 為準。這些目標規格不等於目前全部完成，當前狀態只看 `PROGRESS.md` 與 implementation。

## 穩定產品規則

- 活動截止時間不得超過開始或發布後 24 小時；取餐開始至少晚於截止 30 分鐘。
- 截止前 30 分鐘起，既有顧客的訂單只能增加飲料（總杯數不可減少），不能退出；尚未參與者仍可在未滿容量且未截止時加入。（2026-09-13 調整：原本這段鎖定期完全不能改單，現在改成只擋「總杯數變少」，增加仍然放行，因為只有減少才會影響其他人的優惠計算基礎。）
- 最高優惠級距杯數同時是第一階段容量上限。
- 最終級距只計算截止前已完成付款授權且仍有效的訂單。
- 折扣是級距的折扣百分比（2026-09-18 起，取代原本的固定金額折扣）；每筆訂單依自己的原價計算應付金額，無條件進位到整數元，進位方向有利商家。
- 已送出訂單保存品名、價格與客製化快照；菜單後續修改不得回寫歷史訂單。
- 已授權訂單採替換流程：新 revision 與新授權成功前，原訂單與原授權維持有效。
- 商家可以直接處理自己門市已請款訂單的退款；顧客不能自行退款。長期方向（2026-10-21 確定）是商家與顧客自行解決退款，商家在 App 內自報狀態（填金額與原因，24 小時內可撤銷），平台不代為執行退款；目前程式碼仍是先前「商家按鈕→平台呼叫 LINE Pay refund API」的版本，待遷移。詳見 `docs/payment-rules-and-flow.md`「退款」。
- 取餐結束時間不是店家可設定的欄位，固定為取餐開始後 3 小時；店家設有打烊時間時，取餐開始不得晚到讓這 3 小時超過打烊。取餐憑證自取餐開始起最多保留 3 小時，且不得晚於取餐結束時間；逾期不自動退款。

## 技術方向與邊界

- Mobile：React Native + Expo，Android 為正式目標，Web 為開發預覽。
- Backend：Node.js 內建 HTTP server，業務狀態與權限由 Backend 管理。
- Database：PostgreSQL 是目前本機開發 Backend 與正式多人環境的主要 runtime；所有 repository runtime 已永久切換為 PostgreSQL，交易流程不雙寫。SQLite 僅保留給明確隔離的相容性測試與本機測試腳本。
- Firebase 只負責身份驗證，不作主要交易資料庫。
- LINE Pay 是唯一付款 provider（曾並存的備援 ECPay 已於 2026-08-27 完全移除）。付款、訂單、結算、取餐與 audit 資料不得由 Mobile 直接寫入。
- Secret 只放本機環境檔；任何 `EXPO_PUBLIC_*` 都視為可被 client 讀取的公開設定。

系統實際協作方式見 `docs/AI-architecture.md`；精確欄位、status 與未決策事項分別見 `docs/AI-database-field-spec.md`、`docs/AI-status-candidates.md`、`docs/open-questions.md`。

## 詞彙與命名

- 產品概念：團購活動。
- Mobile／API：`groupBuyActivity`、JSON 欄位使用 `camelCase`。
- Database：`group_buy_activities`、欄位使用 `snake_case`。
- Mobile 既有 `deal` 只作相容脈絡，不應擴大使用。
- 程式、API、schema、status、環境變數使用英文；說明與使用者文案可用中文，必要時保留英文術語並附中文解釋。

## 舊版邊界

舊版 root `frontend/`、`server.js`、`src/`、`data/` 已刪除。除非有明確 migration 需求，不得恢復或建立第二套前後端結構。
