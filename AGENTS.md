# AGENTS.md

## 專案摘要

DrinkGroupBuy 是仍在開發中的 Android-first 手搖飲團購系統：`mobile/` 為 React Native + Expo App，`backend/` 為 Node.js HTTP API；目前本機開發 Backend 的全部 repository runtime 已永久切換至 PostgreSQL，SQLite 僅保留給明確隔離的相容性測試。正式身份方向是 Firebase Auth + Google Login；付款只有 LINE Pay 分離式請款一種方案（ECPay 備援方案已於 2026-08-27 完全移除，見 `docs/AI-security-review-log.md`）。

延續現有 `mobile/`、`backend/`、`database/`、`docs/` 架構。除非使用者明確要求，不得恢復已刪除的 root `frontend/`、`server.js`、`src/` 或 `data/`。

跟使用者溝通一律用繁體中文，不要用簡體中文。

## Source of Truth 與漸進式 Context

實際 implementation、Git diff 與本次驗證證據優先；文件若與程式衝突，先標示不一致或「尚未確認」，不要猜測。不要預設讀完所有 `docs/`，只載入當前任務需要的 Context。

所有任務先讀本檔與直接相關程式。再依任務選擇：

| 任務類型 | 額外載入 |
| --- | --- |
| 小修、UI 文案、局部 Bug | 直接相關 source、鄰近測試；通常不讀專案總覽 |
| 畫面外觀（顏色、字級、圓角、狀態標籤、新畫面） | `docs/ui-style-guide.md` 與 `mobile/src/theme/`；顏色與字級引用設定值、不新增寫死色碼；顏色要透過 `useTheme()`／`useThemedStyles(makeStyles)` 取得（`mobile/src/theme/ThemeContext.jsx`），不可直接 import `colors`／`tones` 用在畫面裡，否則深色模式不會跟著換 |
| 既有功能修改 | 相關 UI → API/service → database 真實路徑；需要判斷進度時才讀 `PROGRESS.md` |
| 新產品功能或流程 | `docs/project-direction.md`、`PROGRESS.md`、`docs/final-product-user-flow.md`、`docs/open-questions.md` 與相關 implementation |
| Architecture、navigation、data flow、外部整合 | `docs/AI-architecture.md`、`PROGRESS.md` 與受影響 source；再按領域讀下面的權威文件 |
| Database/schema | `docs/AI-database-field-spec.md`、`database/schema.sql`、相關 migration／adapter；不得只憑候選文件判斷 runtime |
| Status／產品規則 | `docs/AI-status-candidates.md` 與對應的產品流程或付款規則 |
| Auth、付款、退款、結算 | `docs/payment-rules-and-flow.md`、`docs/AI-security-review-log.md`、相關 source 與測試；提高邊界、權限、併發與失敗路徑檢查強度 |
| 重大決策 | `docs/project-direction.md`、`docs/AI-architecture.md`、相關 domain docs、`docs/open-questions.md` 與 implementation；先提出影響與遷移風險，不直接改 |

`PROGRESS.md` 是目前進度的單一來源。開始或完成一個工作單位時讀 `docs/progress-tracking-rules.md`，只以相稱證據更新。`docs/AI-current-progress.md` 與 `docs/AI-handoff-summary.md` 是歷史快照，不是 current source，也不得作為每次任務的必讀文件。

## 永久工作規則

- 保留現有 worktree 與無關未提交修改；不得擅自 reset、覆蓋、commit 或 push。
- 只修改任務範圍；不因個人偏好更換 framework、architecture、dependency 或產品流程。
- 優先採小型垂直切片，明確追蹤 mobile、API、service、database 與文件的實際串接；route、screen 或 schema 單獨存在不代表 E2E 完成。
- 外部輸入一律驗證；不要以吞錯、放寬權限或寫死案例來讓錯誤消失。控制流程優先用 guard clause，只有意圖確實更清楚時才抽函式。
- 改到 repository 的 SQL（尤其是取餐、付款、結算）時，除了 `npm test`，還要跑 `npm run test:db`：它在一次性暫時 schema 裡跑真實資料庫測試，不碰真實資料。`npm test` 用假資料庫，抓不到「SQL 被 PostgreSQL 拒絕」這類錯誤（2026-10-01 的標記可取餐就是這樣上線的）。部署流程（`.github/workflows/`）的 `test` 工作也會跑它與 `npm test`，不過那是最後一道關卡，不是用來取代本機先跑。
- 修改後執行與風險相稱的 validation；沒有實際執行就不得宣稱通過。若檢查會重建 SQLite、產生 build artifact 或修改外部狀態，先說明並取得同意。
- 不提交或輸出 secret。Backend secret 只放本機 `.env`／`backend/.env`；`EXPO_PUBLIC_*` 會進入 client bundle，不得放付款、Firebase Admin、session 或資料庫機密。
- API JSON／frontend 使用 `camelCase`，database 使用 `snake_case`。新後端與資料庫概念使用 `groupBuyActivity`／`group_buy_activity`；不要擴大 mobile 既有 `deal` 相容名稱。
- 不自行發明 status；依 `docs/AI-status-candidates.md` 與實際 constraints 更新所有受影響層次。

## 高風險與資料安全

- 金流先用 sandbox／mock；未經使用者明確確認，不得啟用真金流 capture、production scheduler、refund 或 provider credential。
- 付款、退款、授權、訂單修改與截止結算必須保有 authentication／authorization、金額重算、transaction、idempotency、併發鎖與 audit trail。
- 任何付款或 auth 程式碼改動完成後，聚焦複查注入、權限、金額竄改、機密與資料外洩，並依檔案頂端格式新增一筆 `docs/AI-security-review-log.md`；即使沒有發現也要記錄。
- SQLite inspection 必須唯讀；不要為了查看現況執行 `db:init`、`db:seed`、migration 或會替換開發 DB 的 smoke script。資料庫 mutation 前先備份，完成後檢查 integrity 與 foreign keys。

## 使用中的角色 Skill（TEAM）

以下角色來自 Global Role Library（`C:\vscode\agency-agents`，來源 [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)），已針對本專案篩選確認為 Core，安裝為全域 Claude Code Skill（不是獨立 subagent，是同一個 Claude 切換的工作模式）。這張表只做路由，角色本身的完整 SOP 在各自的 Skill 檔案裡，不重複抄在這裡。

| 任務類型 | 使用角色 Skill |
| --- | --- |
| 資料庫 schema／API 設計 | `backend-architect` |
| React Native／Expo 畫面開發 | `mobile-app-builder` |
| 驗證某個功能是否真的做完 | `evidence-collector` → `reality-checker`（兩道關卡都要過，不能只跑一個就算數） |
| 一般 bug 修正／小改動 | `minimal-change-engineer`（預設模式：最小 diff、不順便重構、不做防禦性程式碼） |
| 定期整個程式庫資安掃描（不限於這次 diff） | `ai-generated-code-security-auditor`（跟 `/security-review`互補：`/security-review` 只看這次改動的 diff，這個角色掃整個現有程式庫，抓既有、非本次新增的問題） |

尚未安裝為 Skill、只列在分析階段的 Optional／Pre-launch／Future 角色，見對話紀錄中的 TEAM.md 提案；未經確認前不視為本專案的 Active Team 成員。

## 文件與協作

- 欄位精確定義只維護在 `docs/AI-database-field-spec.md`；其他 database docs 連結它，不重抄欄位表。
- 只有使用者流程、API、schema、status、核心規則、重大限制或架構真的改變時，才更新相應文件；不要把 Git history 複製成 changelog 型 Context。
- 多人協作走「個人分支 → Pull Request → 擁有者審核後合併」，不直接推 `main`（推上 `main` 會自動部署）。畫面組員的可改範圍、離線展示模式與 PR 檢查清單見 `docs/ui-collaboration.md`；`backend/`、`database/`、`scripts/`、`.github/`、套件與原生設定的改動需擁有者核准（`.github/CODEOWNERS`）。
- 同一個 implementation task 同時只有一位主要修改者。其他 Agent 可 review 或 validation，但未經要求不順便大改。跨 Agent 的長期資訊必須落在 source、Git 或共享文件，不能只留在 chat memory。
- 修改前先列出預計檔案、原因與不碰的範圍；修改後列出實際檔案、摘要、假設、未決問題與下一步。
