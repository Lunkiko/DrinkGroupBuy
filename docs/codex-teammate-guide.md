# 給 Codex 的協作說明（UI／UX 組員用）

最後更新：2026-10-15

這份寫給在這個專案裡協助「UI／UX 組員」的 AI 工具（Codex 等）。人類請看 [`ui-collaboration.md`](ui-collaboration.md)。回覆組員一律用繁體中文。

## 你的角色

你協助組員調整 App 的畫面外觀與操作體驗。你**只能做 UI**，並且**所有成果都要透過 Pull Request（PR，請求合併）交給擁有者 Lunkiko 審核**。你沒有權限、也不應該嘗試部署、改後端或繞過審核。

開工前先讀：`AGENTS.md`、[`ui-collaboration.md`](ui-collaboration.md)、[`ui-style-guide.md`](ui-style-guide.md)，以及 `mobile/src/theme/`。

## 鐵則（任何情況都不能違反）

1. **不要推 `main`。** 這些都禁止：`git push origin main`、`git push origin HEAD:main`、在 `main` 上直接 commit 後推送。推上 `main` 會自動部署到正式環境。
2. **只在 `ui/` 開頭的分支上 commit 與 push。** 推送前先用 `git branch --show-current` 確認分支名稱，不是 `ui/` 開頭就停下來。
3. **不要強制推送**：不用 `--force`、`--force-with-lease`、`--no-verify`。
4. **只有組員明確要你 commit／push 時才做。** 平常只改檔案、跑檢查，然後回報。
5. **不要用 `git add .` 或 `git add -A`**，一律列出檔案名稱。
6. **不要提交或顯示機密。** `.env`、`google-services.json`、金鑰、token 一律不放進 commit、PR、對話或日誌。需要登入 GitHub 時，請組員自己登入，不要把 token 寫進任何檔案或指令。
   **唯一的例外**：組員改地圖畫面時，會在自己的 `mobile/.env` 放一行擁有者給的 `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=...`（網頁版地圖用，已限制只能在 `localhost` 使用）。你可以協助他建立這個檔案，但**不要印出金鑰的值、不要加入其他變數、不要 `git add` 它**（`.env` 已被 Git 忽略，用 `git status` 確認它沒有出現在變更清單裡）。
7. **不要部署或打包**：不執行 `eas update`、`eas build`、`npm run mobile:apk`。這些由擁有者負責。
8. **不要自己合併 PR**，也不要關閉別人的 PR。

## 可以改／不能改

| 範圍 | 規則 |
| --- | --- |
| `mobile/src/screens/`、`mobile/src/components/`、`mobile/src/theme/`、`mobile/assets/`、`mobile/src/mock/`、`docs/ui-style-guide.md`、`docs/brand/` | 可以改 |
| `mobile/src/utils/`（`apiClient.js` 除外）、`mobile/tests/` | 只在畫面需要時小改，並說明原因 |
| `backend/`、`database/`、`scripts/`、`.github/`、`package.json`、`package-lock.json`（根目錄與 `mobile/`）、`mobile/app.config.js`、`mobile/eas.json`、`mobile/src/utils/apiClient.js`、`mobile/src/state/`、`mobile/src/navigation/`、`AGENTS.md`、`CLAUDE.md` | **不要改。** 需要改時停下來告訴組員，由擁有者處理 |

新增或更新套件也算「不能改」：會牽涉重新打包 APK。

## 推送步驟

### 1. 確認現況

```powershell
git status
git branch --show-current
```

有不是你改的未提交檔案，先問組員，不要動它們。

### 2. 開一條新分支（已經在 `ui/` 分支上就跳過）

分支名稱 `ui/` 加上主題，英文小寫與連字號，例如 `ui/order-card-two-columns`：

```powershell
git fetch origin
git switch main
git pull --ff-only
git switch -c ui/order-card-two-columns
```

### 3. 改檔案，並在離線展示模式看結果

```powershell
cd mobile
$env:EXPO_PUBLIC_DEMO_MODE = "true"
npx expo start --web --port 8083
```

只在命令列帶入這個變數，**不要寫進任何檔案**。結束後關掉該終端機。淺色與深色模式都要看。

### 4. 跑測試（在專案根目錄）

```powershell
node --test "mobile/tests/*.test.mjs"
```

沒通過就修正畫面或顏色，**不要改測試來放寬標準**。

### 5. 檢查改動範圍

```powershell
git diff --name-only origin/main
```

再用下面指令找出碰到「不能改」範圍的檔案，**必須沒有任何輸出**才能繼續：

```powershell
git diff --name-only origin/main | Select-String -Pattern '^(backend|database|scripts|\.github)/|^package(-lock)?\.json$|^mobile/(package(-lock)?\.json|app\.config\.js|eas\.json)$|^mobile/src/(state|navigation)/|^mobile/src/utils/apiClient\.js$|^(AGENTS|CLAUDE)\.md$'
```

有輸出就停下來，告訴組員哪些檔案越界。

### 6. 提交

只加入你改的檔案；訊息開頭用 `ui:`，一句話說明做了什麼：

```powershell
git add mobile/src/screens/GroupBuyActivityDetailScreen.jsx
git commit -m "ui: 團購詳情的商品卡片改成兩欄"
```

### 7. 推送（只推目前這條 `ui/` 分支）

```powershell
git push -u origin HEAD
```

### 8. 開 PR

PR 需要附修改前後截圖，而截圖要在網頁上貼，所以**預設做法是把連結交給組員，請他在瀏覽器開**：

```
https://github.com/Lunkiko/DrinkGroupBuy/pull/new/<你的分支名稱>
```

網頁會自動帶出檢查清單（來自 `.github/pull_request_template.md`），請組員填好、貼上截圖。

如果組員要你直接建立，且本機已安裝並登入 `gh`：

```powershell
gh pr create --base main --title "ui: 團購詳情的商品卡片改成兩欄" --body "改了什麼：...（照 pull_request_template.md 的項目填寫，截圖請組員到網頁補上）"
```

### 9. 推送之後

- 不要自己合併。等擁有者審核。
- 擁有者留言要求修改時，在**同一條分支**繼續改、commit、`git push`（不需要 `-u`），PR 會自動更新。

## 常見狀況

| 狀況 | 怎麼處理 |
| --- | --- |
| 推 `main` 被拒絕（protected branch） | 這是正常的保護機制，**不要想辦法繞過**。改走開 PR |
| `git push` 被拒絕（rejected、non-fast-forward） | 不要強制推送。先 `git fetch origin`，再 `git merge origin/main` 把最新的 `main` 合進來，解決衝突後再推 |
| 要和最新的 `main` 同步 | 用 `git merge origin/main`。**不要 rebase 已經推出去的分支**（rebase 之後必須強制推送，而強制推送是禁止的） |
| 合併時有衝突 | 只處理你自己改過的檔案。衝突出現在「不能改」範圍的檔案，停下來問組員 |
| 測試沒過 | 修畫面或顏色；對比度不夠就調整顏色。不要改測試、不要降低標準 |
| 需要新增套件、改原生設定、改後端或 API | 停下來，告訴組員這需要擁有者處理，並說明原因 |
| 不確定能不能做 | 先問組員，不要猜 |

## 完成後的回報

請告訴組員：

1. 分支名稱與 PR 連結（或建立連結）
2. 改了哪些檔案、各改了什麼
3. 測試結果（有跑才寫通過）
4. 還需要人做的事：貼修改前後截圖（淺色、深色）、有 Android 手機的話實機看一次
