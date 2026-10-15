# UI／UX 協作說明

最後更新：2026-10-15

給負責調整畫面的組員，也給擁有者設定 GitHub 時照著做。外觀的具體規則（顏色、字級、圓角）在 [`ui-style-guide.md`](ui-style-guide.md)，這份只講「怎麼安全地協作」。

## 一句話版本

**不要直接改 `main`。** 每次開一條自己的分支，在電腦上用離線展示模式看畫面，附截圖開 PR，擁有者審過、用手機看過才合併。`main` 一合併，後端會自動部署到 Azure，所以 `main` 是不能亂動的那條線。

## 第一次設定

需要：Git、Node.js 24、一個編輯器。**不需要**資料庫、後端金鑰、Expo 帳號。只有改**地圖畫面**時，才需要擁有者給你一組網頁版地圖金鑰（見下方「地圖畫面」）；其他畫面完全不需要 `.env`。

```powershell
git clone https://github.com/Lunkiko/DrinkGroupBuy.git
cd DrinkGroupBuy\mobile
npm ci
```

## 日常流程

1. 開工前先更新，再開一條新分支（名稱用 `ui/` 開頭，後面寫畫面或主題）：

   ```powershell
   git switch main
   git pull
   git switch -c ui/order-card-two-columns
   ```

2. 改檔案，在下一節的離線展示模式看結果。
3. 只加入你改的檔案，再提交（**不要用 `git add .`**，免得把不相干的檔案一起帶進去）：

   ```powershell
   git add mobile/src/screens/GroupBuyActivityDetailScreen.jsx
   git commit -m "ui: 團購詳情的商品卡片改成兩欄"
   git push -u origin ui/order-card-two-columns
   ```

4. 到 GitHub 開 Pull Request（PR，請求把你的分支合併進 `main`）。範本會自動帶出檢查清單，**改畫面一定要附修改前後截圖**。
5. 測試會自動跑。擁有者審過、用手機看過就合併；有意見會在 PR 上留言，照著再改、再推同一條分支即可。
6. 合併後，切回 `main` 更新，下一件事再開新分支。一條分支只做一件事。

## 在電腦上看畫面（離線展示模式）

這個模式讓 App 完全不連後端，用假資料操作整個流程，顧客與店家兩種身份都能一鍵進入：

```powershell
cd mobile
$env:EXPO_PUBLIC_DEMO_MODE = "true"
npx expo start --web --port 8083
```

瀏覽器打開 `http://localhost:8083`。看完後**關掉那個終端機視窗**（或執行 `Remove-Item Env:EXPO_PUBLIC_DEMO_MODE`），免得這個設定留在同一個視窗裡影響之後的指令。

- **不要**把 `EXPO_PUBLIC_DEMO_MODE` 寫進 `mobile/.env`、`eas.json` 或任何設定檔。旗標是建置時寫死的，寫進去後打包出來的 APK 會整包變成假資料版。
- **網頁不等於手機。** 地圖、字型、手勢、推播、鍵盤彈出的行為都和 Android 不同。所以合併前擁有者會用手機再看一次；你若有 Android 手機，也請在 PR 裡說明有沒有實機看過。
- 假資料重新整理就重置，是正常的。
- 展示模式沒涵蓋的畫面（例如退款、商家申請）會嘗試連後端而失敗，不是你改壞的。

### 地圖畫面

網頁版地圖需要 Google Maps 金鑰，沒有的話只會顯示「尚未設定 Web Google Maps API key」。要改地圖畫面時：

1. 向擁有者**私訊**索取網頁版金鑰（一行 `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=...`）。
2. 在 `mobile/` 資料夾建立 `.env` 檔，**只放這一行**，不要加別的設定。
3. 照上面的方式啟動（一定要用 `--port 8083`）。

注意：

- `mobile/.env` 已被 Git 忽略，不會被推上去；提交前仍用 `git status` 確認它沒出現在清單裡。
- 金鑰**不要貼到** commit、PR、Issue、群組或 AI 對話裡。
- 這把金鑰在 Google 那邊限制只能從 `localhost` 使用，所以只在你自己電腦上看得到地圖；不要拿它做別的用途。
- 擁有者的其他設定（資料庫、LINE Pay、Firebase 管理金鑰等）**不會也不需要**給你。

## 可以改、要小心、不要碰

| 範圍 | 規則 |
| --- | --- |
| `mobile/src/screens/`、`mobile/src/components/`、`mobile/src/theme/`、`mobile/assets/`、`docs/ui-style-guide.md`、`docs/brand/` | **可以改。** 這是你的工作範圍 |
| `mobile/src/mock/`（展示用假資料） | 可以改，用來讓畫面有更好的樣本內容 |
| `mobile/src/utils/apiClient.js`、`mobile/src/state/`、`mobile/src/navigation/` | **先跟擁有者講。** 影響每個畫面，改壞全 App 一起壞 |
| `backend/`、`database/`、`scripts/`、`.github/` | **不要碰。** 金流、登入、資料庫、部署都在這裡 |
| `package.json`、`package-lock.json`、`mobile/app.config.js`、`mobile/eas.json` | **不要碰。** 新增套件或改原生設定要重新打包 APK，線上更新（EAS Update）推不出去 |

被標成「先講」或「不要碰」的路徑，合併前 GitHub 會自動要求擁有者核准（見 `.github/CODEOWNERS`）。

## UI 守則

完整版在 [`ui-style-guide.md`](ui-style-guide.md)，這裡列最容易犯的：

1. **顏色與字級一律從主題取值，不寫死色碼。** 畫面裡用 `useTheme()` 或 `useThemedStyles(makeStyles)`（見 `mobile/src/theme/ThemeContext.jsx`）。不要直接 import `colors`／`tones` 用在畫面裡，也不要寫 `#2563EB` 這種字串，否則深色模式不會跟著換。
2. **全 App 是平的**：不用陰影、漸層、濾鏡；線粗只有 2px 一種。
3. **中文字只用一般（400）與粗體（700）。** 層次靠字級、顏色、留白，不靠其他粗細。
4. **意思不只靠顏色**：狀態標籤一定有文字，再加小記號。
5. **淺色、深色兩種模式都要看**，小螢幕（寬度 375）也要看。
6. **不新增套件。** 想用字型、動畫、圖示套件，先跟擁有者討論，因為會牽涉重新打包。
7. **地圖畫面有兩份**：`LiveMapScreen.native.jsx`（手機）與 `LiveMapScreen.web.jsx`（網頁）。改一份就要同步改另一份。
8. **流程改動要先討論**：新增畫面、改操作步驟、改文案語意，先跟擁有者說。外觀你可以放手調，產品規則由擁有者決定。

## 開 PR 前自己跑一次

在**專案根目錄**執行（不需要資料庫）：

```powershell
node --test "mobile/tests/*.test.mjs"
```

這會檢查顏色對比度、狀態對照等。改了顏色卻沒過，代表某組文字與底色的對比不夠（字會看不清楚），要調整顏色而不是改測試。
完整測試（含後端與資料庫）會在 PR 上由 GitHub 自動跑，不用在自己電腦上跑。

## 避免兩個人改到同一處

- **一個人一次負責一個畫面或元件**，開工前在群組說「我在改哪個檔案」。
- 小改動早點合併，不要讓一條分支放好幾天；放越久，越容易和別人的改動衝突。
- 動到 `AppNavigator.js` 這類大檔案前先說一聲。

## 手機更新由擁有者負責

合併進 `main` 之後，擁有者才會用 EAS Update 把新畫面推到大家的手機。組員**不需要** Expo 帳號，也不要自己發 `preview` 頻道的更新：那個頻道是所有已安裝 App 共用的，實驗版本一推出去，所有人的手機都會收到。

---

## 擁有者：GitHub 一次性設定

repo 設定不在程式碼裡，要到 GitHub 網頁上點。**在這些設定完成前，有 write 權限的人可以直接推 `main`，而推上 `main` 會自動部署到 Azure。**

### 1. 保護 `main`

GitHub 網頁 → 這個 repo → **Settings** → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**。（選項名稱可能隨 GitHub 改版略有不同，意思一樣即可。）

| 項目 | 設定 |
| --- | --- |
| Ruleset name | `protect-main` |
| Enforcement status | **Active** |
| Bypass list | 加入 **Repository admin**（讓擁有者在緊急時能自己合併，一般 PR 仍照規則走） |
| Target branches | **Include default branch** |
| Restrict deletions | 勾選 |
| Block force pushes | 勾選 |
| Require a pull request before merging | 勾選；**Required approvals** 填 `1`；勾 **Dismiss stale pull request approvals when new commits are pushed**；勾 **Require review from Code Owners** |
| Require status checks to pass | 勾選；按 **Add checks** 加入 `test` |

`test` 要等 PR 上至少跑過一次才會出現在可選清單裡：先開一個小 PR，跑完後再回來加。

### 2. 確認部署的最後一道牆（尚未驗證）

repo 的 Secrets 只有 Azure 登入用的 ID（沒有密碼），登入採 OIDC。能不能擋住「有人在別的分支手動觸發部署」，取決於 Azure 端的 **federated credential（聯合身分憑證）** 是不是只信任 `main` 分支。流程檔裡的 `if: github.ref == 'refs/heads/main'` 只能防「手滑」，擋不住有寫入權限、又改了流程檔的人。

Azure Portal → Microsoft Entra ID → App registrations → 這個部署用的 App → Certificates & secrets → Federated credentials，確認 Subject identifier 是 `repo:Lunkiko/DrinkGroupBuy:ref:refs/heads/main` 這種**指定分支**的值，而不是萬用字元。

### 3. 好習慣

- 擁有者自己改程式也開 PR，不直接推 `main`，這樣測試才會在合併前跑。
- PR 合併後把用完的分支刪掉（PR 頁面有 **Delete branch** 按鈕），分支清單才不會越積越多。想保留的舊內容改打標籤（`archive/` 開頭），不要留成分支。
