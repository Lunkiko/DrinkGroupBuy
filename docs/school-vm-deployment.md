# 學校 VM 部署手冊（Windows Server，遠端桌面）

最後更新：2026-10-09

這份手冊說明怎麼把後端與資料庫放到學校提供的 Windows 虛擬機，讓專題展現場的手機連到它。步驟都在 VM 上用遠端桌面操作。

## 目標架構

```text
展示用手機（APK，網址寫死）
        │ http://163.17.135.215:3000
        ▼
學校 VM：Windows Server 2022（公開 IP 163.17.135.215）
  ├─ Node.js 後端（開機自動啟動的排程任務 DrinkGroupBuyBackend，埠 3000）
  └─ PostgreSQL 16（同一台，只接受本機連線）
        │ 對外連線（都已實測可通）
        ▼
  Firebase（驗證 Google 登入）、Expo（推播）、LINE Pay 沙盒
```

## 2026-10-09 實測的 VM 現況

| 項目 | 結果 |
| --- | --- |
| 系統 | Windows Server 2022 Standard **Evaluation（評估版）**，PowerShell 5.1，繁簡中文混用（簡體介面） |
| 網路 | 公開 IP `163.17.135.215`，閘道 `163.17.135.254`，Ethernet0 |
| 工具 | Node v24.18.0、npm 11.16.0、Git 2.55.0 已安裝 |
| 專案資料夾 | `C:\apps\DrinkGroupBuy` 存在，但程式碼是 **2026-07-23 的版本（`eaf56d4`，落後 157 個提交）**，`backend\.env` 是舊的（SQLite 時代） |
| PostgreSQL | **未安裝** |
| 防火牆 | 已有 `DrinkGroupBuy Backend 3000` 的入站規則 |
| 對外連線 | GitHub、npm、Firebase、Expo 推播、LINE Pay 沙盒都通 |
| 已知問題 | **時鐘慢約 8 小時**（時區是 China Standard Time，與台北同為 UTC+8，數值本身偏差）；系統是評估版，有使用期限 |

> 重新檢查隨時可用：`scripts\check-vm-readiness.ps1`（唯讀，不會改任何設定也不會印出密碼）。

## 你需要先決定的兩件事

1. **HTTPS 還是 HTTP？** 這台 VM 沒有網域名稱。
   - **沒有網域（目前狀況）**：只能用 http。release 版 APK 預設拒絕 http，所以要用 `--backend-url http://…` 打包一個專用 APK（見步驟九）。代價：登入憑證與資料用明碼在網路上傳。這只適合專題展這種短期、展示用資料的情境。
   - **向學校申請到網域名稱**：可以做 HTTPS（需要憑證與反向代理），不用特殊 APK。申請得到的話再補一份 HTTPS 步驟。
2. **管理後台怎麼保護？** 見「安全」一節的 `ADMIN_WEB_LOOPBACK_ONLY`，建議開。

## 步驟一：先修時間（最優先）

後端驗證 Firebase 登入憑證時會比對時間，VM 時鐘慢 8 小時會讓**所有 Google 登入失敗**。在管理員 PowerShell：

```powershell
Set-TimeZone -Id "Taipei Standard Time"
w32tm /resync /force
w32tm /query /status
Get-Date
```

`Get-Date` 要和你手機上的時間（台北時間）一致，誤差不超過一分鐘。若 `w32tm /resync` 失敗，可能是學校擋了時間伺服器，改指定校方或公用的 NTP（例如 `time.stdtime.gov.tw`）：

```powershell
w32tm /config /manualpeerlist:"time.stdtime.gov.tw" /syncfromflags:manual /update
Restart-Service w32time
w32tm /resync /force
```

## 步驟二：確認系統授權還剩多久

評估版到期後系統會每小時自動關機。

```powershell
slmgr /dlv
```

看「評估剩餘時間」。**如果剩餘時間短於交付後的展示期間，要請學校 IT 換成正式授權**（這件事只有 VM 的管理者能處理）。

## 步驟三：安裝 PostgreSQL 16

1. 在 VM 上用 Edge 開 `https://www.enterprisedb.com/downloads/postgres-postgresql-downloads`，下載 **PostgreSQL 16 的 Windows x86-64 安裝程式**。
2. 安裝時：
   - 元件只勾 **PostgreSQL Server** 與 **Command Line Tools**（pgAdmin、Stack Builder 不需要）。
   - 連接埠維持 `5432`。
   - 設定 **postgres 超級使用者密碼**，請用強密碼並記在安全的地方。
3. 安裝完成後確認它**只接受本機連線**：

   ```powershell
   netstat -ano | findstr :5432
   ```

   只應看到 `127.0.0.1:5432`、`[::1]:5432`。若看到 `0.0.0.0:5432`，到 `C:\Program Files\PostgreSQL\16\data\postgresql.conf` 把 `listen_addresses` 改成 `'localhost'`，重新啟動服務 `postgresql-x64-16`。**不要為 5432 新增任何入站防火牆規則。**
4. 建立專案用的資料庫與帳號（`<密碼>` 換成新的強密碼）：

   ```powershell
   $psql = "C:\Program Files\PostgreSQL\16\bin\psql.exe"
   & $psql -U postgres -h localhost -c "CREATE ROLE drink_group_buy LOGIN PASSWORD '<密碼>';"
   & $psql -U postgres -h localhost -c "CREATE DATABASE drink_group_buy OWNER drink_group_buy;"
   ```

## 步驟四：更新程式碼

VM 上的專案是公開 GitHub 專案的複本，不需要帳號密碼。先確認遠端網址與是否有本機修改：

```powershell
cd C:\apps\DrinkGroupBuy
git remote -v
git status --short
```

- `git remote -v` 應指向 `https://github.com/Lunkiko/DrinkGroupBuy`（舊網址 `BigAxeReese/DrinkGroupBuy` 也能用，GitHub 會導向）。
- `git status --short` 若列出修改過的檔案，先問清楚是誰改的，不要直接覆蓋。

然後更新（拉最新程式碼、必要時重新安裝套件）：

```powershell
cd C:\apps\DrinkGroupBuy
git pull --ff-only
npm ci
```

> 之後的日常更新用專案根目錄的 `05-update-vm.cmd`（`scripts\update-vm-server.ps1`），它會停掉後端、更新、重新啟動並檢查 `/health`；已經安裝自動啟動任務時，它會透過該任務重啟。

## 步驟五：建立 `backend\.env`

以 `.env.example` 為底，**整份重寫**（舊的是 7 月的版本，缺很多設定）：

```powershell
cd C:\apps\DrinkGroupBuy
Copy-Item backend\.env backend\.env.old-july   # 先備份舊的
Copy-Item .env.example backend\.env
notepad backend\.env
```

必須修改的項目（機密不要貼進對話或提交到 Git）：

| 項目 | 設定 | 來源／說明 |
| --- | --- | --- |
| `PORT` | `3000` | 與防火牆規則、`update-vm-server.ps1`、APK 網址一致 |
| `AUTH_SESSION_SECRET` | 新產生的隨機字串（32 字元以上） | 產生：`[Convert]::ToBase64String((1..32 \| ForEach-Object { Get-Random -Maximum 256 }))`；**不要沿用 Azure 的值** |
| `AUTH_DEV_MODE` | **`false`** | VM 有公開 IP，開發登入模式一定要關。`install-vm-service.ps1` 看到 `true` 會拒絕安裝 |
| `ADMIN_WEB_LOOPBACK_ONLY` | `true`（建議） | 管理後台只允許在 VM 本機開啟，見「安全」 |
| `ADMIN_WEB_PASSWORDS` | 強密碼（可用逗號分隔多組） | 後台共用密碼；`.env.example` 沒列這項，說明見 `docs/azure-classroom-deployment.md` |
| `FIREBASE_PROJECT_ID` | `drinkgroupbuy-mobile` | 與 App 同一個 Firebase 專案 |
| `FIREBASE_SERVICE_ACCOUNT_JSON` 或 `GOOGLE_APPLICATION_CREDENTIALS` | 服務帳戶金鑰 | 從 Firebase Console 取得；若用檔案，放在 `C:\apps\secrets\`，且只給系統管理員與 SYSTEM 讀取權限 |
| `FIREBASE_WEB_API_KEY`、`FIREBASE_WEB_AUTH_DOMAIN`、`FIREBASE_WEB_APP_ID` | 與 `mobile\.env` 相同 | 公開設定，不是機密 |
| `DATABASE_URL` | `postgres://drink_group_buy:<密碼>@localhost:5432/drink_group_buy` | 步驟三建立的帳號；密碼含特殊字元要做網址編碼 |
| `DATABASE_SSL` | `false` | 本機 PostgreSQL 不用 TLS |
| 所有 `*_RUNTIME` | `postgres` | `.env.example` 已經是 `postgres`，不要改 |
| `LINE_PAY_CHANNEL_ID`、`LINE_PAY_CHANNEL_SECRET` | 沙盒金鑰 | 從 Azure 入口網站 → App Service → 環境變數取得，或 LINE Pay 沙盒後台 |
| `LINE_PAY_CONFIRM_URL`、`LINE_PAY_CANCEL_URL` | `http://163.17.135.215:3000/api/payments/line-pay/confirm`（與 `cancel`） | 必須是**手機瀏覽器連得到**的網址 |
| `LINE_PAY_APP_RETURN_URL` | `drinkgroupbuy://payment/result` | 與 App 的 scheme 一致 |
| `SETTLEMENT_SCHEDULER_ENABLED`、`PICKUP_EXPIRATION_SCHEDULER_ENABLED` | `true` | 展示要看到自動結算與取餐逾期；Azure 展示環境曾關閉，VM 要開 |
| `ALERT_WEBHOOK_URL` | 留空 | 沒有告警頻道就不設 |

## 步驟六：建立資料表與資料

```powershell
cd C:\apps\DrinkGroupBuy
$line = Get-Content backend\.env | Where-Object { $_ -like 'DATABASE_URL=*' } | Select-Object -First 1
$env:DATABASE_URL = $line.Substring('DATABASE_URL='.Length)
npm run postgres:migrate
Remove-Item Env:\DATABASE_URL
```

預期輸出「Applied N migration(s). Now at version 010」。這會建立所有資料表與開發用的基礎資料（店家、菜單、測試帳號，其中包含管理員帳號 `user-admin-001`，`ADMIN_WEB_PASSWORDS` 對應到它）。

**展示用歷史資料**（讓統計頁與個人中心有東西可看，順序很重要）：見 `docs/azure-classroom-deployment.md` 的「展示用假資料」一節。在 VM 上對本機資料庫執行時不需要 `--allow-remote`：

```powershell
npm run demo-data -- --focus-email <你的Google信箱>            # 先預覽，不寫入
npm run demo-data -- --focus-email <你的Google信箱> --apply   # 確認後才寫入
```

## 步驟七：安裝成開機自動啟動的服務

管理員 PowerShell：

```powershell
cd C:\apps\DrinkGroupBuy
powershell -ExecutionPolicy Bypass -File .\scripts\install-vm-service.ps1 -DryRun   # 先看會做什麼
powershell -ExecutionPolicy Bypass -File .\scripts\install-vm-service.ps1
```

它會：檢查 `.env`（`AUTH_DEV_MODE=true` 會拒絕安裝）、確保防火牆規則、註冊排程任務 `DrinkGroupBuyBackend`（開機自動啟動、以 SYSTEM 執行、當掉每 1 分鐘重啟）、啟動並檢查 `/health`。日誌寫在 `C:\apps\DrinkGroupBuy\logs\backend.log`。

**一定要做開機測試**：重新啟動 VM，等 2 分鐘，不登入遠端桌面，從你自己的電腦確認 `http://163.17.135.215:3000/health` 回 `{"ok":true,…}`。

## 步驟八：設定每日備份

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\backup-vm-database.ps1             # 立刻備份一次
powershell -ExecutionPolicy Bypass -File .\scripts\backup-vm-database.ps1 -Register   # 每天 03:00 自動備份
```

備份放在 `C:\apps\backups\`，保留 14 天，且每次備份都會驗證檔案可讀（讀不了就刪掉並報錯）。還原方式見腳本開頭的註解；**還原前先停掉後端、先備份現狀**。

## 步驟九：外部連線測試與打包 APK

1. **從外面測**：用手機的**行動網路**（不要連校內 Wi-Fi）開瀏覽器到 `http://163.17.135.215:3000/health`，要看到 `{"ok":true,…}`。再用校內 Wi-Fi 測一次。兩種網路都要通。
   - 不通：代表學校的邊界防火牆擋了入站 TCP 3000，要請 IT 開放（只要這個埠，且限於展示期間）。
2. **打包 VM 專用 APK**（在你自己的電腦）：

   ```bash
   npm run mobile:apk -- --backend-url http://163.17.135.215:3000
   ```

   產生 `mobile\apk\<月日>-vm.apk`。這個 APK 會：把後端網址寫死成 VM、允許 http、**關閉 EAS 自動更新**（否則之後我們從電腦發更新，會把它導回 Azure）。要更新程式，重新打包再安裝。
3. **備案 APK**（離線展示模式，完全不連後端，用假資料展示整個流程）：

   ```bash
   npm run mobile:apk -- --demo
   ```

   產生 `<月日>-demo.apk`，同樣凍結更新。現場網路或 VM 出狀況時用它救場。
4. 用 VM 版 APK 在校內 Wi-Fi 與行動網路各走一遍：Google 登入、瀏覽地圖與團購、下單、LINE Pay 沙盒付款、商家標記可領取、推播通知。

## 安全

| 風險 | 處理 |
| --- | --- |
| 管理後台密碼用 http 明碼傳送、登入頁對全世界開放 | 在 `backend\.env` 設 `ADMIN_WEB_LOOPBACK_ONLY=true`：`/admin`、`/dev-console`、`/api/admin/` 只接受 VM 本機的請求，外部看起來是 404。要用後台就在 VM 裡開 Edge，網址 `http://127.0.0.1:3000/admin`。**不要在 VM 上再架本機反向代理**，否則所有請求都會被當成本機，這個保護就失效 |
| 開發登入模式 | `AUTH_DEV_MODE=false`；安裝腳本會擋 |
| 登入憑證與資料以明碼傳輸（沒有 HTTPS） | 只適合展示用資料；不要在上面使用真實個資。拿到網域名稱後改 HTTPS |
| 遠端桌面（3389）對網際網路開放 | 使用強密碼、確認啟用「網路層級驗證（NLA）」；有可能的話請學校把 3389 限制為你們的來源 |
| 資料庫不應對外 | 不要為 5432 開入站規則；`netstat -ano \| findstr :5432` 只應看到本機位址 |
| 機密 | `backend\.env` 與服務帳戶金鑰只放在 VM，不進 Git、不貼進對話；Azure 部署期間曾外露過的機密（PostgreSQL 密碼、Firebase 金鑰、`AUTH_SESSION_SECRET`）VM 這邊都用新的 |
| 評估版授權到期 | 步驟二 |

## 日常操作

| 要做什麼 | 怎麼做 |
| --- | --- |
| 看後端是否正常 | `http://163.17.135.215:3000/health`，或 VM 上 `Get-ScheduledTask DrinkGroupBuyBackend` |
| 看日誌 | `Get-Content C:\apps\DrinkGroupBuy\logs\backend.log -Tail 50`（持續追蹤加 `-Wait`） |
| 重啟後端 | `Stop-ScheduledTask DrinkGroupBuyBackend; Start-ScheduledTask DrinkGroupBuyBackend` |
| 更新程式 | 雙擊 `05-update-vm.cmd`（有新 migration 時它會警告，要手動跑 `npm run postgres:migrate`，跑之前先備份） |
| 手動備份 | `scripts\backup-vm-database.ps1` |
| 移除自動啟動 | `scripts\install-vm-service.ps1 -Uninstall` |
| 整體健檢 | `scripts\check-vm-readiness.ps1` |

## 疑難排解

| 症狀 | 常見原因 |
| --- | --- |
| Google 登入一直失敗 | VM 時鐘不準（步驟一）；`FIREBASE_*` 設定錯；VM 連不到 Google（跑 `check-vm-readiness.ps1`） |
| 手機連不到後端 | 學校邊界防火牆擋了入站 3000；VM 防火牆規則不在；後端沒啟動（看 `/health` 與日誌） |
| App 顯示連線失敗但瀏覽器 `/health` 正常 | APK 沒用 `--backend-url` 打包（release 版預設拒絕 http）；或 APK 指向舊的 Azure 網址 |
| 後端啟動就結束 | `backend\.env` 缺項或資料庫連不上，看 `logs\backend.log`；`DATABASE_URL` 的密碼要網址編碼 |
| 付款沙盒回不到 App | `LINE_PAY_CONFIRM_URL`／`LINE_PAY_CANCEL_URL` 不是手機瀏覽器連得到的網址 |
| 推播收不到 | 手機要先登入並允許通知；VM 要連得到 `exp.host`；後端日誌看 `[push-notification]` |
| VM 重開機後後端沒起來 | 任務是否存在（`Get-ScheduledTask`）；資料庫服務 `postgresql-x64-16` 是否自動啟動 |

## 交接清單

- [ ] 時鐘正確（步驟一）、評估版剩餘天數已確認（步驟二）
- [ ] PostgreSQL 16 已安裝、只聽本機、備份任務已註冊
- [ ] `backend\.env` 重寫完成，`AUTH_DEV_MODE=false`，`ADMIN_WEB_LOOPBACK_ONLY=true`，機密不在 Git
- [ ] 重開機測試通過（不登入也能連到 `/health`）
- [ ] 外部（行動網路）與校內 Wi-Fi 都連得到後端
- [ ] VM 版 APK 與展示備案 APK 已打包並實際安裝測過
- [ ] 完整流程走過一遍：登入 → 下單 → 付款沙盒 → 截止結算 → 可領取 → 取餐核銷 → 推播
- [ ] Azure 防火牆舊規則已刪除、Downloads 的金鑰已移到安全位置
- [ ] 管理員帳號、資料庫帳號、遠端桌面密碼已交給接手的人
