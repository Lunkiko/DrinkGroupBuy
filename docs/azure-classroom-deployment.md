# Azure 課堂展示環境

最後更新：2026-10-04（「專題展現場注意事項」補上學校網路已可用）

## 目前狀態（2026-09-11）

- **已建立**：Azure 資源群組 `drinkgroupbuy-demo-rg`、PostgreSQL Flexible Server `drinkgroupbuy-demo-hc`、App Service `drinkgroupbuy-demo-api`。
- **已完成**：資料庫 migration（目前版本 010，2026-10-04 套用）已套用；PostgreSQL 防火牆已開放給 App Service（讀寫資料庫的 API 已驗證回應正常）；App Service 環境變數已設定（PostgreSQL 連線、`AUTH_SESSION_SECRET`、`ADMIN_WEB_PASSWORDS`、各 `*_RUNTIME` 等）；Backend 已部署（`GET /health` 與需要資料庫的 API 皆已驗證回應正常）。
- **已建立但僅供內部測試**：Android APK 已重新打包，使用 Debug Key 簽署（不是正式上架用的簽署金鑰），已設定連到 Azure 這個公開 HTTPS 網址；發布版（release）建置，JS 程式碼包在檔案裡，不需要連著開發電腦就能獨立執行。
- **已完成**：Firebase／Google Cloud Console 的 Android OAuth 用戶端 SHA-1 已直接用工具驗證跟這版 APK 簽章一致；在真的 Android 手機用真的 Google 帳號，實際走過一次「登入 → 自動註冊為顧客」的完整流程，並用真實姓名顯示＋資料庫帳號 ID 格式兩項證據交叉確認過是真的全新註冊，不是誤判；App Service 環境變數已確認包含 `FIREBASE_PROJECT_ID`／`FIREBASE_SERVICE_ACCOUNT_JSON`。
- **⚠️ 已偏離下方「安全起始值」範本**：使用者要求課堂展示環境的開團／下單／付款／時間到期結算都要跟正式版行為一致，2026-09-11 已開啟 `SETTLEMENT_SCHEDULER_ENABLED`、`PAYMENT_RECONCILIATION_ENABLED`（連同 `PAYMENT_RECONCILIATION_ALLOW_PRODUCTION`，因為這個判斷的是 `NODE_ENV` 不是金流環境）、`PICKUP_EXPIRATION_SCHEDULER_ENABLED`，並補上 LINE Pay sandbox 真實憑證與指向 Azure 網址的 `LINE_PAY_CONFIRM_URL`／`LINE_PAY_CANCEL_URL`——**LINE Pay sandbox 付款路徑現在是真的會被呼叫**，不再是「不測付款路徑」的狀態；`LINE_PAY_ENV` 仍維持 `sandbox`，沒有開真實金流。之後如果要重新部署或建立第二套環境，不要照抄下方範本的 `false`，要參照這裡目前的真實狀態。詳見 `docs/AI-security-review-log.md` 2026-09-11 第四次追加。
- **尚未完成**：
  - 還沒有實際走過一次「開團 → 下單 → LINE Pay sandbox 預授權 → 截止結算 → 請款」的完整流程驗證這些排程真的照預期運作。
  - 尚未進行兩個帳號、兩種網路的跨網路端對端驗證（目前只驗證過一支手機、一個帳號）。
  - 部署過程中，PostgreSQL 密碼、Firebase Service Account Key、`AUTH_SESSION_SECRET` 曾經在操作過程的畫面上出現過；正式交付前應輪替這三項，目前使用者已知悉此事、決定暫緩處理。

以下操作手冊維持原樣，供之後需要重新部署或建立第二套環境時參考；不要假設下面列的「建立與部署順序」步驟都還沒開始。

## 目的與邊界

這份操作手冊只處理非商業的課堂展示環境：組員在不同網路安裝同一個 Android APK，透過 Azure 的公開 HTTPS 網址連到同一套 Backend 與 PostgreSQL 資料庫。

固定拓撲：

```text
Android APK（組員手機）
        ↓ HTTPS
Azure App Service（Node.js Backend）
        ↓ PostgreSQL + TLS
Azure Database for PostgreSQL Flexible Server
```

- 不使用 Azure VM；不需要維護 Linux 作業系統。
- 不開啟 LINE Pay production、真實 capture、refund 或 production scheduler。
- Azure for Students 的 US$100 是 12 個月總額，不是每月 US$100。建立資源時仍要確認畫面標示的方案與預估月費。
- App Service Free F1 可能休眠並受每日 CPU 配額限制，適合上課展示，不適合依賴常駐背景排程或正式營運。

## 固定資源選擇

兩個服務放在同一個 Azure 區域與同一個資源群組，名稱可依入口網站可用性調整：

| 資源 | 選擇 |
| --- | --- |
| Resource group | `drinkgroupbuy-demo-rg` |
| App Service | Linux、Code、Node.js 24 LTS、Free F1 |
| PostgreSQL | Flexible Server、PostgreSQL 16、Burstable B1ms；只有入口網站明確顯示符合免費額度時才建立 |
| Database storage | 32 GiB 或免費方案允許的最低值 |
| App Service HTTPS Only | 開啟 |
| App Service Always On | 免費 F1 不支援，不依賴此功能 |

## Repository 已準備的啟動契約

- Azure 以 `npm start` 啟動 `backend/server.js`。
- Backend 使用 Azure 注入的 `PORT`，不要在 App Service 手動設定 `PORT`。
- `GET /health` 是 App Service 的基本健康檢查網址。
- 所有秘密只放在 App Service 的「環境變數」，不得寫入 Git、APK 或任何 `EXPO_PUBLIC_*` 變數。
- PostgreSQL 必須使用 TLS 並驗證伺服器憑證；若密碼含 `@`、`:`、`/`、`#` 等字元，放進 `DATABASE_URL` 前要做 URL encoding（網址編碼）。

## App Service 環境變數

下列是展示環境的安全起始值。尖括號內容由 Azure 或 Firebase 實際值取代；不要把真實值貼回文件。

```text
NODE_ENV=production
AUTH_DEV_MODE=false
AUTH_SESSION_SECRET=<至少 32 個隨機字元>
ADMIN_WEB_PASSWORDS=<課堂管理員使用的高強度密碼>

DATABASE_URL=postgresql://<admin-user>:<url-encoded-password>@<server>.postgres.database.azure.com:5432/postgres
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true
DATABASE_POOL_MAX=2

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
PAYMENT_CAPTURE_RUNTIME=postgres
GROUP_BUY_SETTLEMENT_RUNTIME=postgres
ORDER_REVISION_RUNTIME=postgres
PAYMENT_REFUND_RUNTIME=postgres
PICKUP_CREDENTIAL_RUNTIME=postgres
PAYMENT_RELIABILITY_JOB_RUNTIME=postgres
MERCHANT_ACTIVITY_CANCEL_RUNTIME=postgres
MANUAL_LINE_PAY_REPAYMENT_RUNTIME=postgres

LINE_PAY_ENV=sandbox
LINE_PAY_API_BASE_URL=https://sandbox-api-pay.line.me
LINE_PAY_CAPTURE_SEPARATED=false
PAYMENT_CAPTURE_RUNTIME_ALLOW_PRODUCTION=false

PAYMENT_RECONCILIATION_ENABLED=false
PAYMENT_RECONCILIATION_ALLOW_PRODUCTION=false
SETTLEMENT_SCHEDULER_ENABLED=false
SETTLEMENT_SCHEDULER_ALLOW_PRODUCTION=false
PICKUP_EXPIRATION_SCHEDULER_ENABLED=false
```

若課堂要使用 Google 登入，另外把 `FIREBASE_PROJECT_ID` 與 `FIREBASE_SERVICE_ACCOUNT_JSON` 放進 App Service 環境變數。`FIREBASE_SERVICE_ACCOUNT_JSON` 是秘密，只能從 Firebase Console 取得並保存在伺服器端；不要設定 `GOOGLE_APPLICATION_CREDENTIALS` 指向本機 Windows 路徑。

若課堂要展示 LINE Pay sandbox，再設定 sandbox 的 `LINE_PAY_CHANNEL_ID`、`LINE_PAY_CHANNEL_SECRET`、`LINE_PAY_CONFIRM_URL` 與 `LINE_PAY_CANCEL_URL`。後兩者必須換成 App Service 的 HTTPS 網址。未完成 sandbox 設定前，不測付款路徑。

## 建立與部署順序

1. 在 Azure 建立資源群組與 PostgreSQL Flexible Server，確認訂用帳戶是 `Azure for Students`，並再次檢查入口網站的預估費用。
2. PostgreSQL 防火牆先只允許執行 migration 的目前電腦；App Service 建好後，再加入它的 outbound IP。不要永久開放 `0.0.0.0` 到 `255.255.255.255`。
3. 在本機暫時設定指向 Azure 的 `DATABASE_URL`、`DATABASE_SSL=true`、`DATABASE_SSL_REJECT_UNAUTHORIZED=true`，執行 `npm run postgres:migrate`。這會修改 Azure 資料庫，執行前必須再次確認目標主機名稱。
4. 是否套用 `database/production-reference-seed-postgres.sql` 要另外確認；它不是 migration 的一部分，也不得重複執行。
5. 建立 Linux App Service，選 Node.js 24 LTS 與 Free F1，部署 repository root，設定上一節環境變數。
6. 開啟 `https://<app-name>.azurewebsites.net/health`，確認回傳 `{"ok":true,"service":"drink-group-buy-backend"}`。
7. 把 `mobile/.env` 的 `EXPO_PUBLIC_BACKEND_URL` 改成 App Service HTTPS 網址，再建立第一版 APK。此 URL 會進入 App，因此不可放任何秘密。
8. 用兩個不同網路（例如 Wi-Fi 與手機行動網路）登入與讀寫同一筆測試資料；完成前只能標示為「已部署、尚未跨網路驗證」。

## 更新規則

- **只改 Backend**：App Service 的部署中心已設定 GitHub Actions 持續部署（CI/CD），`git push` 到 `main` 會自動觸發建置與部署，不需要手動操作 Cloud Shell 或 Portal；設定檔在 `.github/workflows/main_drinkgroupbuy-demo-api.yml`（Azure 自動產生並提交）。第一次接上這個設定時，第一次自動部署可能因為 Azure 剛建立的身份驗證設定還沒在 Entra ID 傳播完成而失敗（`No subscriptions found` 之類的錯誤），重新觸發一次通常就會過。
- 改 Mobile JavaScript／畫面／圖片：EAS Update 已完成設定並實機驗證成功，`eas update --branch preview` 發布後，已安裝的 APK 重開後會跳出更新提示，不用重打 APK。**前提**：APK 必須是透過 `eas build` 或有明確在 `app.config.js` 設定 `updates.requestHeaders["expo-channel-name"]` 的方式打包出來的——本機純用 `expo run:android`／`gradlew assembleRelease` 打包會跳過 `eas build` 自動注入頻道設定的步驟，即使 `expo.modules.updates.ENABLED=true`、更新網址正確，仍會因為不知道自己屬於哪個頻道而永遠收不到更新（2026-09-12 已實際遇到並修好這個問題，見 `PROGRESS.md`）。
- 改原生套件、Android 權限、Expo SDK 或其他 native 設定：即使已有 EAS Update，仍要重新打包 APK。

## 專題展現場注意事項

**學校 Wi-Fi 可能擋掉 Google 地圖底圖。** 2026-10-01 實測：同一份 APK，一位組員在學校 Wi-Fi 下看到的地圖是粉紅空白底加店家圖釘（圖釘與店名是我們自己後端的資料；街道底圖是每台裝置直接向 Google 地圖伺服器要的，被擋），換成自己的行動網路就正常。這跟 Azure 或後端放在哪裡無關，只跟「看畫面那台裝置」走的網路有關，所以展示用的設備若必須連學校網路就會遇到。

**目前狀態（2026-10-04）**：使用者回報學校網路下地圖已可正常顯示，這個風險暫時解除。下面的處理順序保留，換場地或換網路時照用。

展示前建議依序處理：

1. **先到展場用學校網路實測一次**，不要等到當天。
2. 若被擋，向學校資訊處提出**限期、限範圍**的放行申請（只要展示期間，並把網域直接列給對方）：`*.googleapis.com`、`*.google.com`、`*.gstatic.com`、`mt0.google.com`～`mt3.google.com`（地圖圖磚）。也可以先問主辦單位有沒有限制較少的活動／訪客網路。
3. 備案（不保證）：在有網路的地方先把展示範圍的地圖開過、滑過一遍，Google 會把看過的圖磚暫存在裝置上；另外準備一段地圖正常運作的錄影。

**不依賴後端的展示版**：`EXPO_PUBLIC_DEMO_MODE=true` 的離線展示模式（見 `mobile/README.md`「離線展示模式」）可以讓人在網頁上直接操作介面，用的是假資料，不會動到 Azure 上的資料。它仍然需要能載入 Google 地圖，所以上面的網路問題照樣會影響地圖畫面。以 Expo tunnel 提供掃 QR code 連線時，那台電腦要保持開機、連線中斷後要重新啟動；開著期間等於把本機開發伺服器公開在網路上，展示完就關掉。

## 展示用假資料（歷史團購與統計）

課堂展示時要有可看的統計與個人中心「省錢統計」，可以用 `scripts/seed-demo-data.js` 一次產生約 30 場歷史團購、約 200 筆訂單、24 位假顧客（產生邏輯在 `scripts/helpers/demoDataBuilder.js`，金額用正式的折扣函式計算，跟真的結算結果一致）。

**它做什麼、不做什麼**

- 只寫入已結束的歷史資料（完成／失敗／取消），日期散佈在過去 60 天；不會產生進行中的團購，所以現場要展示「開團、下單」請當場操作。
- 付款一律是 `mock_line_pay` 假付款，不會碰真的 LINE Pay。所有資料的 ID 都以 `demo-seed-` 開頭，可以整批移除。
- 假顧客沒有 Firebase 綁定也沒有密碼，無法登入；他們只是讓統計有分母（每位顧客在同一場團購只能下一張單，只靠既有的顧客 A～D 湊不到 10～30 杯的優惠門檻）。既有的顧客 A～D（migration 002 寫入）若存在，會自動一起參加大部分團購，他們的個人中心也會有數字。
- 自動排程不會碰這些資料：結算排程只處理招募中／已成團的活動，取貨逾期排程只處理進行中的活動，付款對帳排程只處理真實 LINE Pay 的待處理授權，假資料都不在這三類。

**在 Azure 上執行的順序（順序錯了會讓展示壞掉）**

1. 先把要展示的真實 Google 帳號用手機登入一次（會自動建立顧客帳號）。假資料要掛在這個帳號底下，個人中心才會有省錢數字。
2. 清空 Azure 上現有的團購活動：`DELETE FROM group_buy_activities;`（migration 008 要求相關資料表是空的，否則會擋下）。
3. **同時**部署新版 Backend（`git push` 到 `main` 觸發 CI/CD）並套用 migration 008（見上面「建立與部署順序」第 3 步）。舊版 Backend 讀不到新欄位，新版 Backend 讀不到舊欄位，兩件事要連續做完，中間短暫不可用。
4. 在本機暫時設定指向 Azure 的 `DATABASE_URL`、`DATABASE_SSL=true`、`DATABASE_SSL_REJECT_UNAUTHORIZED=true`，並確認 Azure 防火牆已允許這台電腦。先預覽（不會寫入）：

   ```bash
   npm run demo-data -- --allow-remote --focus-email 你的Google信箱@gmail.com
   ```

5. 預覽的目標主機名稱與內容確認無誤後，加上 `--apply` 才會真的寫入：

   ```bash
   npm run demo-data -- --allow-remote --focus-email 你的Google信箱@gmail.com --apply
   ```

6. 展示完要移除：`npm run demo-data -- --allow-remote --cleanup --apply`。

腳本內建的保護：沒有 `--apply` 不寫入；目標不是本機資料庫時沒有 `--allow-remote` 會拒絕；資料庫還沒套用 migration 008 會拒絕；已經有示範資料時不會重複寫入；整批寫入是單一交易，失敗時資料庫維持原狀。可用參數見 `node scripts/seed-demo-data.js --help`。

已知限制：假顧客會出現在後台的帳號管理清單；在本機開發模式下也會出現在「測試身份」切換選單；假的團購掛在真實店家底下，所以會算進那些店家的統計與營收排行（這是展示用途的預期行為，移除示範資料後就會恢復）。

## 暫停與清理

- 不展示時可停止 App Service；PostgreSQL 是否能停止及免費額度規則以 Azure 當下畫面為準。
- 課程結束後，如果不再使用，刪除整個 `drinkgroupbuy-demo-rg` 可一起移除 App Service、PostgreSQL 與相關資源。刪除前先確認資料是否需要匯出；刪除資源群組不可復原。
