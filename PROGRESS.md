---
updated: 2026-10-04
---

## 功能總覽 [完成]
> 一次性列出這個專案目前實際涵蓋的功能範圍，純粹給人看整個專案大致有哪些東西，不是要追蹤完成度的工作項目。
- 顧客瀏覽附近店家與團購活動（地圖、距離與條件篩選）
- 顧客加入團購並用 LINE Pay 付款
- 顧客修改已加入的訂單內容
- 顧客取貨（憑證核銷）
- 顧客查看訂單與付款狀態
- 商家建立與取消團購活動
- 商家管理店內菜單
- 商家標記訂單可取餐、查看待製作明細
- 商家申請退款
- 管理員網頁後台審核退款、取消團購、審核商家申請
- 管理員在網頁後台切換已註冊帳號的顧客／商家使用角色
- 系統截止結算（折扣試算、正式請款）
- 系統付款背景可靠性機制（對帳、重試、告警）

## 身份驗證與角色 [進行中]
> 決定使用者是誰、能用哪些功能——例如是一般顧客還是店家老闆，登入之後系統要怎麼分辨身份。
- Firebase Auth + Google 登入 [進行中]
  > 讓使用者可以直接用自己的 Google 帳號登入，不用另外設一組新密碼；背後用 Google 官方的身份驗證服務（Firebase Auth）確認身份是真的。這個功能核心就是串接 Google／Firebase 這個第三方服務，不是自己設計的業務邏輯，所以底下不分「前端畫面」「後端 API」，直接歸類成第三方服務整合。
  - Mobile 端（第三方服務整合） [完成] — Google 登入畫面，取得 Firebase ID token 送到 backend；按鈕文案已改為「使用 Google 登入／註冊」，反映第一次登入即完成註冊
  - Backend 端（第三方服務整合） [完成] — 驗證 ID token，依 users/user_roles/merchant_users 判斷身份
  - 顧客首次登入自動註冊 [完成] (9/11)
    > 第一次用 Google 帳號登入的人，系統自動幫他建立顧客帳號，不用工程師手動把這個 Google 帳號對應進資料庫。以前完全沒有這個功能：任何沒有被預先手動對應好的 Google 帳號登入一律被拒絕（回傳「帳號未對應」錯誤），這個專案第一次有「一般使用者自己登入就能建立正式帳號」的路徑。新帳號一律只拿到顧客角色，不能自己取得商家或管理員身份。
    - 新增 `backend/database/repositories/customerRegistrationRepository.js`，接上 `/api/auth/firebase-session` 原本直接回錯的分支；同時修改既有商家審核交易（`merchantApplicationRepository.js`）：已自動註冊為顧客的帳號若之後申請商家並被核准，帳號會轉換成商家（停用顧客角色、啟用商家角色，同一個帳號 ID，不會兩個角色並存——這是與你確認過的政策）。已對真實 PostgreSQL 直接執行驗證：全新帳號建立、重複登入不重複建立、兩個同時的首次登入正確收斂成一筆、不同帳號同 email 正確擋下且不建立資料、停用帳號正確被拒絕、顧客轉商家的角色轉換正確生效且訂單／稽核歷史不受影響。測試資料已清除，`npm test` 99/99 全過，`check:sql-safety` 通過，安全審查記錄見 `docs/AI-security-review-log.md` 2026-09-11。**真機 Google 登入機制已驗證可用**：在真的 Android 手機上安裝課堂展示 APK，成功用真實 Google 帳號完成登入，證明 SHA-1／OAuth 憑證設定正確。但**這次登入實際上是登進舊的種子測試帳號**（`user-customer-yinji`，這個 Google 帳號先前已被手動綁定過），不是真的全新自動註冊，一開始誤判為自動註冊成功，已更正。已把該帳號的 `firebase_uid` 解除綁定，並在重新部署上述兩個 Mobile 端修正後，用真正的登出鍵登出、重新登入同一個帳號，**這次已確認真正成功建立全新帳號**：登入後畫面顯示的是真實 Google 姓名（不是裝飾假名），且 `/admin/accounts` 查到的帳號 ID 是全新產生的英數字格式（不是 `user-customer-yinji`）——兩項證據都對得上，這次不是誤判。過程中順手發現並修正兩個 Mobile 端真實問題：首頁原本顯示的是寫死的裝飾用假人設名稱（跟真實帳號無關，任何後端沒特別認得的帳號一律顯示成固定的「A」），已改成讀取後端真實的 `displayName`；同時移除首頁、個人中心、商家後台三處會把已登入使用者導回登入頁的「會員」按鈕（Firebase 登入上線前的舊功能殘留，正常情況不應該出現）。這兩處連同 Backend 都已重新打包成新版 APK 並實機驗證，`npm test` 115/115 全過；本機重新產生 Android 原生專案時發現舊版 APK 沒有正確接上 EAS Update（`expo.modules.updates.ENABLED` 是 false），已重新產生原生專案並確認新版 APK 的簽章 SHA-1 與 Google Cloud 登記的一致、JS 程式碼正確包進獨立可執行的發布版（release）APK 裡（不需要連開發電腦）。
  - Firebase Console／OAuth／UID mapping 與 Android 實機 E2E（整合驗證） [完成] (9/11) — Firebase／Google Cloud 的 Android OAuth 用戶端已確認 SHA-1 憑證指紋與 APK 簽署金鑰一致；真正的「全新帳號自動註冊」已在真機上乾淨驗證成功（見上方說明）。管理員與預先寫死的商家 seed 帳號仍需要手動對應 Firebase UID，且既有的 `scripts/map-firebase-user.js` 只會改本機 SQLite 檔案，backend 已經永久切到 PostgreSQL 之後這支腳本對現在的 runtime 沒有作用——這部分維持已知的工具缺口，還沒有可以用的替代方案
    > 正式上線前要在 Google 的管理後台（Firebase Console）完成登入相關設定，並且要用真的 Android 手機實際測試一次完整登入流程，不只是在電腦模擬器上測。
- 登入狀態持久化（App 重開不用重新登入） [進行中] (8/29) — 真機測試發現 App 完全關閉重開後一定要重新登入，因為 `authToken` 原本只存在 JS 記憶體變數（`mobile/src/utils/apiClient.js`），沒有任何持久化機制。已補上：登入成功時把憑證存進 `expo-secure-store`（Android 專用的加密本機儲存，web 因瀏覽器沒有對應機制而略過）；App 啟動時讀回並呼叫新增的 `GET /api/auth/session`（見 [AI-api-candidates.md](docs/AI-api-candidates.md)）重新驗證，成功才略過登入畫面、失敗（401）則清掉本機憑證回到登入畫面。角色對應起始畫面的邏輯抽成共用的 [authRouting.js](mobile/src/utils/authRouting.js)，登入當下與 App 啟動還原共用同一份。`npm test` 93/93 全過，backend 新路由已用真實 HTTP 請求驗證（有效 token 回傳正確使用者、無效 token 回傳 401）。**尚未實機驗證**：需要真的關閉重開 App 確認能跳過登入畫面
  > 手機上把 App 完全關掉再打開，應該要記得使用者剛剛登入過，直接進到對應的畫面，不用每次都重新登入一次。
- 管理員帳號角色切換 [進行中] (9/11)
  > 管理員可以在網頁後台把已有商家門市資料的帳號切換成商家或顧客使用模式。切換只停用目前不用的權限與介面，不刪除帳號、顧客訂單、個人資料、商家門市或歷史紀錄；後端權限立即生效，使用者登出重登或完全關閉 App 後重開，就會進入目前啟用的單一角色介面。第一次成為商家仍必須先完成商家申請審核，避免產生沒有門市可管理的商家身份。
  - 《開發》Backend 角色交易與管理後台 [完成] — 新增 `/admin/accounts` 搜尋／切換頁面、service 與 PostgreSQL repository；清單顯示資料庫保留的所有已註冊帳號（含啟用、停用、已刪除與管理員），管理員及非啟用帳號只讀。顧客／商家角色在同一個交易內互斥切換，`merchant_users` 連結只停用／啟用，所有顧客與商家資料都保留；管理員帳號不可在此頁被降權，每次有效變更會寫入 `admin_account_role_changed` 稽核紀錄。
  - 《測試》權限、資料保留與角色互斥自動化驗證 [完成] — 新增 11 個 service／repository 測試；完整 `npm test` 115/115 通過、`check:sql-safety` 通過、`git diff --check` 無錯誤。本機 HTTP 驗證 `/admin/accounts` 登入後回 200、未登入會導回登入頁、偽造 CSRF 的角色切換請求回 403；測試沒有實際切換任何現有帳號。
  - 《審查》身份授權與資料安全複查 [完成] — 已檢查管理員授權、CSRF、目標角色白名單、SQL injection、XSS、交易鎖、角色撤銷、資料保留、稽核紀錄與秘密外洩；結果見 `docs/AI-security-review-log.md` 2026-09-11 同日追加。
  - 《部署／實機》Azure 與 Android 端對端驗證 [進行中] (9/11) — 這批 backend 變更（帳號角色切換、登入失敗鎖定）已重新部署到 Azure App Service，`/admin/accounts` 已確認在正式站上可連線（回 302 導向登入頁，不是 404）。**尚未完成**：還沒用一個已核准商家測試帳號在正式站上實際來回切換角色、確認兩種手機介面顯示正確。
  - 帳號清單依角色分區顯示 [完成] (9/17) — 原本 `/admin/accounts` 把顧客、商家、管理員全部帳號混在同一條列表裡，帳號一多（例如 14 筆）很難找到特定一間店的商家帳號；改成依目前角色分成「商家帳號」「顧客帳號」「管理員帳號」三個區塊各自標示筆數，純顯示排版調整，未改變任何角色切換邏輯或資料。已用瀏覽器確認本機種子資料正確分成 7 筆商家／4 筆顧客／1 筆管理員三區，`node --check` 語法檢查通過。
  - 額外拆出「測試帳號」分類 [完成] (9/17) — 使用者實際在 Azure 上看到的帳號清單裡混著真人 Google 登入帳號（如「JingWei Weng」）跟一次性寫進資料庫的 seed／測試帳號（例如 7 家 demo 商家、`admin@example.com`），希望能分開。判斷規則：帳號 ID 是不是真的 UUID 格式（真正註冊流程一律產生 `user-${隨機UUID}`，seed 資料當初是手動取名如 `user-merchant-001`）、或信箱網域是不是 `.test`／`example.com` 這類保留的測試網域，符合任一個就歸進新的「測試帳號」分類，其餘才照原規則分商家／顧客／管理員。已用本機真實資料庫驗證：12 筆本機 seed 帳號（1 管理員＋4 測試顧客＋7 demo 商家）全數正確歸進「測試帳號」；另外建一筆 UUID 格式、Gmail 信箱的假帳號測試，正確歸進「顧客帳號」而非「測試帳號」，測完已清除。`npm test` 138/138 全過。
  - 加上分類篩選分頁籤 [完成] (9/17) — 使用者原本看到的是全部分類一次攤開顯示，希望能只挑一個分類看；先做成下拉選單，使用者看過截圖後表示想要的是分頁籤（tab）樣式，改成一排可以直接點的圓角按鈕（全部／商家／顧客／管理員／測試帳號／其他），點了哪個就用底色標示目前選的是哪個。過程中測出一個真實的可用性問題：篩選到本機沒有任何真實商家帳號的「商家帳號」分類時，畫面原本只是一片空白、沒有任何提示，容易被誤會成壞掉；已補上「這個分類目前沒有符合的帳號」提示文字。已用瀏覽器實測點擊「商家」分頁籤（正確標示為選取中、正確顯示空分類提示）與「測試帳號」分頁籤（正確只顯示 12 筆測試帳號）兩種情境，`npm test` 138/138 全過。
  - 《設計》App／管理後台強隔離 [待處理] — 現況是同一個 App Service 下以 `/admin` 路徑、獨立密碼、HttpOnly／Secure Cookie、server-side admin role、CSRF 與 audit 做邏輯隔離；若從課堂展示走向正式營運，應改用獨立後台 hostname／App Service，並接 Microsoft Entra ID 或等效管理員身份、個人白名單／群組及 MFA。這需要 Azure 身份與網域設定，尚未執行。
- 管理員每人獨立信箱密碼登入 [進行中] (9/11)
  > 讓每個管理員用自己的信箱＋密碼登入 `/admin` 網頁後台，取代原本所有管理員共用同一組密碼的方式；共用密碼保留當備援登入管道，不移除。信箱身份本身透過 Firebase 建立，跟顧客／商家用的 Google 登入是同一個 Firebase 專案下的不同登入方式，只是不綁個人 Google 帳號。
  - 《開發》登入頁信箱表單與後端驗證 [完成] — `/admin/login` 新增信箱＋密碼登入表單（可切換「建立帳號」），要求 Firebase 信箱已驗證才放行；新端點 `POST /admin/login/firebase` 重用既有顧客自動註冊邏輯，新帳號一律只拿到顧客角色，須另外被授予管理員角色才能進 `/admin`。只在 `backend/.env` 有設定 `FIREBASE_WEB_API_KEY`／`FIREBASE_WEB_AUTH_DOMAIN`／`FIREBASE_WEB_APP_ID` 時才顯示，未設定時登入頁維持原本純密碼表單。
  - 《開發》授予／撤銷管理員角色腳本 [完成] — 新增 `scripts/grant-admin-role.js`（`npm run admin-role:grant`），刻意不做成網頁自助功能；授予前會即時向 Firebase 查證信箱已驗證，避免對未經確認的信箱授權。
  - 《開發》本機一鍵登入 [完成] — 本機開發模式（`AUTH_DEV_MODE=true`＋只限本機連線）下，登入頁多一顆按鈕可跳過輸入密碼；初版寫成單純 `GET` 就自動登入，複查時發現這樣任何跨來源背景請求都能被動觸發，已改成需要真人點擊按鈕才會送出的同源請求，見 `docs/AI-security-review-log.md` 2026-09-11 第五次追加。
  - 《審查》身份驗證安全複查 [完成] — 檢查自助建立帳號是否可能直接取得管理員權限、信箱驗證是否可被略過、新登入路徑是否繞過既有登入失敗鎖定、SQL injection、機密外洩；結果見 `docs/AI-security-review-log.md` 2026-09-11 第五次追加，發現一個中風險問題（本機一鍵登入的被動觸發風險）已在同一輪修正。
  - 《驗證》[完成] (9/12) — 使用者在 Firebase Console 開啟 Email/Password 登入方式後，用真實帳號（`admin@example.com`）實際登入 `/admin`。過程中發現並修好一個 bug：`POST /admin/login/firebase` 誤判每一個成功登入的帳號都是「已停用」（讀取一個 repository 查詢從未回傳過的 `user.status` 欄位），導致修復前所有信箱密碼登入一律被擋下；修好後重新測試成功進入後台首頁。`npm test` 115/115 全過，見 `docs/AI-security-review-log.md` 2026-09-12 第二次追加。本機端對端驗證完整，Azure 部署後的驗證仍待補。
- 顧客／商家信箱密碼登入 [進行中] (9/12)
  > 手機 App 登入頁除了 Google 登入，也能用信箱＋密碼登入／註冊，重用管理員那套 Firebase 機制。跟管理員不同：不需要額外被授予角色，第一次登入成功即自動拿到顧客角色，跟現有 Google 登入行為一致；商家身份仍須另外走商家申請審核，不因登入方式而不同。信箱必須先完成驗證才能真正登入，避免用打錯或非本人的信箱下單、事後聯絡不到人。
  - 《開發》登入頁信箱表單 [完成] — `RoleSelectScreen.jsx` 新增信箱密碼表單（可切換「建立帳號」）與「忘記密碼」，`firebaseAuth.js` 新增 `useFirebaseEmailLogin`（`signUpWithEmail`／`signInWithEmail`／`resetPassword`）；後端 `POST /api/auth/firebase-session` 新增 `email_verified` 檢查，只影響第一次登入的自動註冊分支，既有 Google 登入（信箱天生已驗證）不受影響，錯誤訊息也從「Google 帳號」改成通用說法。
  - 《審查》身份驗證安全複查 [完成] — 檢查是否可能用未驗證信箱建立帳號、是否可能取得比顧客更高權限、忘記密碼與登入錯誤訊息是否洩漏帳號是否存在；結果見 `docs/AI-security-review-log.md` 2026-09-12，沒有發現問題。
  - 《驗證》[完成] (9/12) — 使用者在 Firebase Console 開啟 Email/Password 登入方式後，用綁定好的測試帳號（顧客 `test-customer-yinji@drinkgroupbuy.test`、商家 `store1@example.com`）實際在真實 Expo web preview 登入成功，分別正確進入顧客首頁與「青山手作茶 中科店」商家後台。表單排版（桌面與手機 375px 寬度）、登入／建立帳號切換、錯誤訊息顯示皆已驗證。`npm test` 115/115 全過。本機端對端驗證完整，Azure 部署後的驗證仍待補。
  - 登入頁插圖換成系統分析書藍圖裡的線稿插畫 [完成] (9/16) — 原本 `LoginHeroIllustration` 是純用 RN View 疊色塊拼出來的抽象插畫（綠色色塊＋杯子＋「折省團買」浮動標籤），使用者指定要換成 `system-analysis/blueprints/4.1.1.2.1-customer-google-login-blueprint-s25-v2.png`（登入畫面藍圖）裡的飲料＋購物袋線稿圖示。用 PowerShell `System.Drawing` 從藍圖原圖裁出純圖示部分（去掉手機外框、狀態列、「DrinkGroupBuy」文字與 A/B/C/D 標註），存成 `mobile/assets/login-hero.png`，畫面端改成單純 `Image` 元件讀取這個靜態圖檔，移除舊插畫用不到的一整組 style（blob／cup／ticket 等）。**特別確認過不是新的原生依賴**——只是 Metro 既有的靜態圖片打包機制（跟這次稍早滑桿元件造成的原生模組閃退是不同類型的改動），可以透過 EAS Update 線上更新直接生效，不需要重新打包 APK。已用 Web 預覽截圖比對確認畫面正確顯示，`npm test` 138/138 全過，已推送並發布 EAS Update。
- 種子測試帳號改綁信箱密碼 [進行中] (9/12)
  > 讓 `user-customer-yinji`、`user-merchant-001`、`user-admin-001` 這幾個既有種子測試帳號，可以直接用固定的信箱密碼登入，取代原本要透過本機開發模式下拉選單或綁定真實 Google 帳號的方式，方便測試與展示。
  - 《開發》綁定腳本 [完成] — 新增 `scripts/bind-seed-firebase-account.js`（`npm run seed-account:bind`），取代舊版對 PostgreSQL 已無作用的 `scripts/map-firebase-user.js`；透過 Firebase Admin SDK 直接建立帳號並標記「已驗證」（不走一般自助註冊的收信點連結流程，只給操作者自己已知、負責任綁定的測試信箱用），並清除該帳號原本可能殘留的舊 Firebase 綁定。
  - 《審查》[完成] — 確認腳本不對應任何 HTTP 路由、只有掌握伺服器端機密的操作者能執行、綁定前會清除衝突的舊綁定；結果見 `docs/AI-security-review-log.md` 2026-09-12 同日追加，沒有發現問題。
  - 《驗證》[完成] (9/12) — 已對本機真實 PostgreSQL 與真實 Firebase 專案實際執行三次，執行前後查資料庫確認 `firebase_uid`／`email` 正確更新，`user-customer-yinji` 原本殘留的舊 Firebase UID（見 9/11 已知問題）已正確清除。使用者開啟 Firebase Email/Password 登入方式後，三個帳號（顧客、商家、管理員）都已實際成功登入驗證過，見 `docs/AI-security-review-log.md` 2026-09-12 第二次追加。
- 商家自助申請＋管理員審核 [進行中] (9/10)
  > 讓想成為商家的人自己在登入頁填申請表送出，不用工程師手動寫資料庫；管理員在後台審核，核准後這個人才能用同一個 Google 帳號登入看到自己的商家後台。這是這個專案第一個「執行期間才會建立商家資料」的路徑，之前所有商家都是一次性寫死在 SQL 裡。刻意縮小範圍：這次只做到「商家帳號可以建立」，商家自己的 LINE Pay 收款帳號、金流改成直接給商家、月費帳單這三塊都還沒做。
  - Backend 端 [完成] — 新資料表 `merchant_applications`（`database/migrations/007_merchant_applications_postgres.sql`）；`POST /api/merchant-applications` 公開端點（驗證 Firebase ID token，身份只信任伺服器端解出來的 claims，不信任 request body）；`/admin/merchant-applications` 三支路由（列表、核准、駁回），完全比照既有退款審核頁的授權／CSRF／交易鎖定模式；核准時在同一個交易裡建立（或重用）`users`、新增 `merchants`／`stores`／`merchant_users`／`user_roles`，任何一步衝突（例如申請人其實已經是別間店的商家）整筆回滾不留孤兒資料。已對真實 PostgreSQL 直接呼叫 repository 四個函式驗證：申請成功、重複待審申請被擋、核准後五張表各自正確新增一筆、重複核准正確 no-op、駁回正確、已是商家的帳號再次核准正確觸發錯誤且整筆回滾；另外用瀏覽器實際登入 `/admin` 後台跑過整頁渲染與核准表單真實送出，並個別驗證沒 session 回 302、CSRF token 錯回 403。過程中發現並修正一個真實 bug：核准失敗時，給管理員看的錯誤訊息被原始錯誤代碼蓋掉（物件屬性展開順序寫反）。測試資料驗證後已清除；`npm test` 99/99 全過；安全審查記錄見 `docs/AI-security-review-log.md` 2026-09-10。
  - Mobile 端 [進行中] — 登入頁新增「申請成為商家」按鈕，新畫面 `MerchantApplyScreen.jsx`（先 Google 登入驗證身份，再填店名／地址／電話送出，送出後顯示靜態確認畫面）。**尚未實機驗證**：這台環境無法模擬真實 Google 帳號登入，「申請人真的用手機走完 Google 登入 → 填表 → 送出」與「核准後這個帳號真的能重新登入看到商家後台」這兩段，都只驗證到後端邏輯層，沒有做到真正的手機端對端測試——跟既有「Firebase Console／OAuth／UID mapping 與 Android 實機 E2E」這個已知缺口是同一類、還沒解決的限制。
  - 已知缺口／刻意不做的範圍 [待處理]
    > 這次核准畫面不能編輯商家填的店名／地址／電話，管理員只能照登，另外多填經緯度；申請端點沒有防濫用機制（這個專案目前完全沒有 rate limiting 基礎設施）；申請人送出後沒有地方查審核進度，也沒有通知機制。

## 團購與活動探索 [進行中]
> 顧客瀏覽附近有哪些店家、有哪些手搖飲團購活動可以參加的畫面與功能。
- 店家地圖 [完成] (8/4)
  > 用地圖顯示附近有哪些店家，顧客可以直接在地圖上找店家、看活動。
  - Mobile 端 [完成] — Android/Web 地圖顯示，mock 檔已移除
  - Backend 端 [完成] — `GET /api/stores`
- 團購活動列表與折扣試算（級距／預估折扣／尾差） [完成]
  > 列出目前有哪些團購活動，並即時算出「現在湊了幾杯」對應的折扣——級距指的是「滿幾杯打幾折」的門檻，尾差是湊不滿下一個門檻時多出來的零頭金額怎麼分攤。
  - Mobile 端 [完成] — 首頁、活動詳情、地圖顯示折扣摘要
  - Backend 端 [完成] — 折扣試算與活動列表 API，核心運算（`backend/pricing/groupBuyDiscount.js`）有 35 個自動化測試，`npm test` 剛實測執行全數通過
- 取餐結束時間改為系統自動計算 [完成] (8/20)
  > 團購的「取餐結束時間」不是店家自己設定的欄位，固定為取餐開始後 3 小時；若店家有設定打烊時間，取餐開始時間不能晚到讓這 3 小時超過打烊。
  - Backend 端 [完成] — 建立團購活動 API 不再接受店家傳入取餐結束時間，改由後端固定算為取餐開始 + 3 小時（`backend/server.js` 的 `computeActivityPickupEndAt`）；新增 `stores.pickup_closing_time` 欄位（`HH:MM`，可為 NULL＝24 小時營業）與對應驗證邏輯（`backend/pickup/pickupWindow.js`，SQLite／PostgreSQL 兩條寫入路徑皆有接上），4 個新單元測試與既有 `npm test`（63 項）全數通過；已用真實 PostgreSQL 16 手動驗證「允許」「拒絕」「剛好卡在打烊前 3 小時邊界」三種情境皆正確，驗證後已把測試值改回 NULL 避免影響其他既有測試對「取餐時間沒有上限」的假設
  - Mobile 端 [完成] — 商家建立團購畫面移除「取餐結束」選擇欄位，只保留「取餐開始」；連帶修正原本容易誤讀成「取餐結束」的既有提示文字（其實指的是上方「結束時間」＝團購截止時間）；新增後端拒絕時的中文錯誤訊息（顯示店家打烊時間與最晚可設定的取餐開始時間）
  - 已知缺口 [待處理] — 目前沒有商家介面可以設定 `pickup_closing_time`，只能透過資料庫直接設值；所有既有店家目前都是 NULL（不設上限）
- 團購截止時間需與打烊時間保持緩衝 [完成] (9/17)
  > 商家設定團購「截止時間」（停止讓顧客加入的時間點）時，如果店家有設定打烊時間，截止時間不能太晚——太接近打烊，商家會來不及準備取餐。這條跟上面「取餐開始時間不能太晚」是兩條各自獨立的檢查，不是同一條規則的延伸。
  - Backend 端 [完成] — 沿用既有 `stores.pickup_closing_time` 欄位，新增獨立驗證函式：`deadlineAt` 不得晚於「打烊時間 − 1 小時」，否則回傳 409 `deadline_too_close_to_store_closing`（`backend/pickup/pickupWindow.js` 的 `validateDeadlineAgainstClosingTime`，跟既有取餐時間檢查共用同一個「打烊前留多少緩衝」的算法，只是各自帶不同緩衝時間與錯誤代碼；SQLite／PostgreSQL 兩條寫入路徑皆有接上）；純函式 4 個新單元測試、repository 層另外新增 4 個測試（用假資料庫驗證兩條打烊時間檢查在真正的寫入流程裡確實有跑到、順序正確、擋下時不會誤觸後續的商家權限查詢），與既有 `npm test` 共 146 項全數通過；另外用本機真實 PostgreSQL 直接呼叫 repository（繞過 HTTP 層）驗證失敗時交易有正確回滾、沒有留下孤兒資料
  - Mobile 端 [完成] — 新增後端拒絕時（`deadline_too_close_to_store_closing`）的中文錯誤訊息，格式比照既有的取餐時間錯誤訊息；尚未實際在畫面上觸發過這個錯誤路徑做人工操作驗證
  - 展示資料 [完成] — Azure 課堂展示環境的 9 間店家已隨機設定打烊時間為 `23:00` 或 `23:30`（原本全部是 NULL／24 小時營業），讓這條規則與既有的取餐時間規則在展示時真的會生效；本機開發資料庫維持全部 NULL 不變，避免影響其他測試假設
- 建立團購活動的開始／截止時間下限 [完成] (8/27) — 真機測試時發現 `validateCreateActivity` 完全沒擋「開始時間在過去」與「截止時間緊接開始時間」（曾成功建立一場僅 3 分鐘的團購）。補上兩條檢查：`startAt` 不得早於當下（allow 60 秒誤差吸收請求延遲，手機建團畫面本來就固定送出當下時間，這條主要擋直接打 API 的情況）；`deadlineAt` 與 `startAt` 至少間隔 30 分鐘（沿用系統既有的 30 分鐘緩衝單位，純防呆下限，不是建議時長）。決策記錄見 `docs/open-questions.md`「團購活動與優惠」；已對真實 PostgreSQL 手動重啟後端驗證新規則生效，`node --check` 通過，`mobile` 測試套件 34/34 全過
  > 商家建立團購時，系統應該擋掉明顯不合理的時間設定（開始時間設在過去、或整場團購只開幾分鐘），避免顧客根本來不及參加。
- 商家自助取消團購 [進行中]
  > 團購截止前，商家自己可以取消已發布的活動；系統會一併取消底下的訂單，並退還顧客還沒正式請款的預付款項。之前只有工程師用的後台工具能取消，而且不會處理訂單和退款，等於是半成品。
  - Backend 端 [完成] (8/17) — 新增取消 API，含店家歸屬檢查、截止前 30 分鐘鎖定、逐筆取消訂單並撤銷 LINE Pay／ECPay 預授權；2 個新自動化 smoke test（含撤銷失敗情境）與既有完整測試套件全數通過，並完成一次安全審查（見 `docs/AI-security-review-log.md`）
  - Mobile 端 [進行中] (8/17) — 商家後台加了取消按鈕與填寫原因表單，基本流程（空白原因擋下、取消成功、顧客端同步顯示已取消、鎖定窗口內按鈕停用）已在瀏覽器人工操作驗證過。但後來為修正 code review 問題而調整的「只標記真的取消成功的訂單」「部分失敗時顯示對應提示」這兩處，只驗證到自動化測試層級，還沒有重新用瀏覽器實際操作確認畫面顯示正確
  - 管理員取消團購入口 [完成] (8/22) — 底層連動邏輯（訂單取消／付款作廢／audit log）沿用 8/20 已驗證過的版本，未再改動；這次只把入口從手機 App 裡的開發用畫面搬到獨立的 `/admin` 網頁後台（見下方「管理員網頁後台」），手機 App 端不再有任何管理員畫面。已用真實 HTTP 請求（含 CSRF token 驗證、session 驗證、對不存在的活動 ID 觸發並確認正確回傳錯誤訊息）人工驗證新入口本身接得起來，未實際對真實資料觸發一次成功取消
  - 管理員無條件取消（不受狀態／截止鎖定限制） [完成] (8/28) — 真機操作時發現管理員取消 `ordering`／`failed` 狀態的團購會被擋下「這個團購目前的狀態無法取消」（沿用商家自助取消的「僅限 recruiting 狀態＋截止前 30 分鐘鎖定」限制，但管理員的強制取消不該受這個保護商家的規則限制）。`cancelMerchantGroupBuyActivity` 新增 `unconditional` 參數，只有兩個管理員取消路由會傳入，商家自助取消完全不受影響（新增 smoke test 情境驗證兩邊行為都對）。已跟使用者確認設計：**已請款（`payment_status = captured`）訂單這次刻意不處理**——不取消、不退款，退款維持走既有「商家申請、管理員核准」的獨立退款流程，不併入取消團購邏輯。已用瀏覽器對真實 PostgreSQL dev 資料庫實際操作驗證兩種情境（`ordering`／`failed`）皆能成功取消且已請款訂單完全不受影響；安全審查記錄見 `docs/AI-security-review-log.md` 2026-08-28
  - 管理後台團購列表分「進行中」／「歷史」 [完成] (8/28) — `/admin` 首頁原本是單一列表，現在依狀態拆成「進行中團購」（draft/recruiting/confirmed/ordering/ready_for_pickup）與「歷史團購」（completed/failed/cancelled）兩區塊並各自顯示筆數，與既有「退款審核」頁的「待審核／審核紀錄」分區樣式一致
    > 工程師/營運人員取消團購用的入口，取消團購時會一併取消底下的訂單、撤銷已經預先鎖定的顧客付款，避免留下資料兜不起來的訂單。
- 附近公里數篩選 [完成]
  > 讓顧客可以依照目前位置的公里數篩選店家與團購，跟「跟手機要真實定位權限」是分開的兩件事——這裡先做篩選邏輯，還沒有真的請求手機定位。
  - 距離計算工具 [完成] (8/17) — 新增座標距離計算與格式化函式，5 個單元測試涵蓋已知座標、缺座標、公尺／公里格式化邊界，`npm test` 全數通過
    > 算出顧客目前位置跟每個店家距離幾公里的核心邏輯，給篩選功能用。
  - 即時地圖／首頁附近推薦列表串接 [完成] (8/19) — Android 模擬器人工操作＋比對真實店家座標計算的實際距離，確認篩選邏輯正確（6 間測試店家全在 0.723 公里內，「1 公里」與「不限」結果理應相同，非 bug）；程式碼核對 `visibleMapStores`／`recruitingGroupBuyActivitiesWithDistance` 篩選與排序邏輯正確；因目前資料庫沒有招募中的團購活動，首頁列表本身尚未有畫面上的排序／篩選人工比對案例
    > 把「距離計算工具」接到地圖畫面跟首頁推薦列表上，讓使用者在畫面上真的看得到、用得到公里數篩選。
  - 即時地圖篩選面板（招募中開關／優惠門檻／取餐時間） [完成] (8/25，8/25 跑過 `/code-review` 並修復) — 依 `system-analysis/藍圖.docx` 4.1.2.2 規格，把地圖畫面的距離篩選升級成完整篩選面板：只看招募中開關（預設關閉，維持既有「預設顯示全部店家」行為）、搜尋半徑（點按式級距，不限排最前與其餘兩個篩選一致）、優惠門檻（不限／滿10／20／30杯）、取餐時間（不限／30分鐘內／1小時內，已過期不算）；優惠門檻與取餐時間兩者同時設定時，要求同一筆可加入活動同時滿足兩個條件，不是各自找不同活動分別滿足（使用者確認的複合條件語意）。套用後地圖同時顯示「已套用條件・符合 N 間」摘要文字，且改用計時器每 30 秒重新計算一次，避免「取餐時間」篩選結果因為時間流逝而沒有跟著過期。選取的店家標記若被之後套用的篩選條件排除，資訊卡會自動收合，不會留著失效的「查看活動」按鈕。只套用在即時地圖（Android／Web），首頁「附近熱門活動推薦」的距離下拉選單（`DistanceRadiusFilter`）改成直接沿用同一份 `RADIUS_OPTIONS`，不再各自維護一份不同步的清單。地圖畫面共用邏輯抽成 `useActivityMapFilters` hook，兩個平台的 state／memo／套用流程不再各自複製一份。`SegmentButton`／招募中開關補上 `accessibilityRole`／`accessibilityState`／`accessibilityLabel`。新增/更新共 7 個單元測試（含複合條件案例，距離篩選測試改成即時讀取真正的 `calculateDistanceKm` 原始碼而非另外重寫一份公式），`npm test` 84/84 全過；Web 預覽人工操作驗證面板開關、四項條件切換、套用後摘要／符合店家數正確更新、取消（✕）不套用未送出的草稿變更、預設不勾選招募中時能看到全部店家
    > 讓顧客除了距離之外，還能一次篩掉太早/太晚取餐、優惠門檻還沒到、或已經沒有招募中的團購，不用逐一點開活動才知道符不符合需求。
- 商家建立團購活動時，斷線會偷偷建立顧客看不到的本機假活動 [完成] (8/25) — [MerchantGroupBuyActivityCreateScreen.jsx](mobile/src/screens/MerchantGroupBuyActivityCreateScreen.jsx) 原本在「後端真的連不上」（純網路層失敗，不是資料驗證錯誤）這個情境下，會呼叫本機專用的 `actions.createMerchantGroupBuyActivity(...)` 建一筆只存在手機本機、從未送到後端的活動，還告訴商家「已用本機 prototype 建立」並直接跳轉回商家首頁——商家會以為活動建好了，但這筆活動不會被寫進資料庫，顧客完全看不到也加入不了。使用者確認後改成：斷線時直接顯示錯誤訊息並停在原畫面，不再偷偷建立假資料；連帶移除只有這個分支在用的 `actions.createMerchantGroupBuyActivity`（`AppNavigator.js`）與未再使用的 `PICKUP_WINDOW_MS` 常數。已用真實後端重新驗證「正常建立活動」流程仍正常（新活動出現在商家首頁「進行中活動」清單），`npm test` 77/77 全過
  > 商家開團如果剛好連不上網路，原本系統會騙商家說「建好了」，其實只是手機自己記了一筆假資料，顧客永遠看不到、也搶不到——現在會老實顯示「建立失敗，請檢查網路後重試」，不會再讓商家誤以為團購已經開成功。
- 正式定位隱私流程 [進行中] (8/25 補一筆真機驗證) — 真的跟手機要 GPS 權限、取得即時座標的程式碼（`Location.requestForegroundPermissionsAsync` / `getCurrentPositionAsync`）本來就寫好了，但只有透過本機測試控制台把某個測試帳號的定位模式切成「即時位置」才會觸發，不是正式環境會自動走的路徑；8/25 真機（非模擬器）實際測過一次，系統跳出 Android 原生定位權限請求、使用者同意後，後端有收到真實回報（`locationMode: live`、`locationPermission: granted`），確認底層機制在真手機上真的能動。過程中發現並修正一個真機專屬的連線缺口：本機測試控制台的後端路由刻意設計成只接受「本機自己連自己」的連線（`isLoopbackRequest`），用區網 IP（LAN IP）連一定會被擋，跟網址對不對無關；真機必須改用 `adb reverse tcp:3001 tcp:3001` 把手機的 `127.0.0.1:3001` 請求透過 USB 隧道送回電腦，後端才會判定為本機連線放行，已把 `mobile/.env` 的 `EXPO_PUBLIC_DEV_CONSOLE_URL` 改成這個方式並補上說明註解。8/27 補上正式環境的請求路徑：非開發模式下 `effectiveLocationMode` 直接固定為 `"live"`，不再永遠停在預設座標，畫面一開啟就會走既有的 `requestForegroundPermissionsAsync` 流程，交給 Android/iOS 原生的定位權限對話框處理告知與同意，不另外疊加一層 App 內的說明畫面（使用者確認手機原生的權限請求本身已經足夠）；如果使用者拒絕，畫面上會出現「請開啟定位權限」的提示卡片，附「前往設定開啟」（`Linking.openSettings()`）與「先不要，使用預設位置」（關閉提示、當次畫面停用預設座標）兩個按鈕。`node --check`／babel 語法檢查通過，**尚未經過 Android 真機操作驗證**，只有本機定位（8/25 那筆）驗證過底層機制能動，這次正式環境自動觸發與拒絕後提示卡片還沒有人工看過
  > 要跟手機要「目前所在位置」權限時，怎麼告知使用者、怎麼取得同意，並且符合隱私規範的正式流程——底層真的能跟手機要到定位這件事今天已經驗證過，但還沒有一套「正式環境會自動觸發、有清楚告知」的完整流程。
- 即時地圖「回到目前位置」按鈕 [完成] (8/25) — Android（`LiveMapScreen.native.jsx`）與 Web 預覽（`LiveMapScreen.web.jsx`）都加了浮動圓形按鈕，按下後地圖鏡頭平滑移動回使用者目前定位點；Web 預覽驗證按鈕正常顯示與點擊，`npm test` 77/77 全過
  > 使用者手動拖曳或縮放地圖跑掉後，可以一鍵讓地圖鏡頭跳回自己目前的位置，不用自己重新找。
- 即時地圖店家標記客製化外觀（含店名） [完成，維持文字疊層版] (9/14)
  - 第一版：文字標籤疊層（不動 Marker 本身） [完成，目前使用中] (9/14) — `LiveMapScreen.native.jsx` 新增店名文字標籤，疊在圖釘下方常駐顯示（不用點下去才看到）。刻意不用 `react-native-maps` 的自訂 Marker 內容（把 View 塞進 `<Marker>`）：這個專案先前在 8/19 升級 Expo SDK 57 時，已經在真機上實際踩過「`react-native-maps` 在新版渲染架構（New Architecture）下顯示異常」的問題（地圖整個空白，詳見上方「Expo SDK 57 升級」），而自訂 Marker 內容正是已知在 New Architecture 下容易出問題的用法；這一版改用另一條路：圖釘維持原生內建的 `pinColor`（已驗證穩定），店名文字另外用普通的 `<View>`／`<Text>` 疊在地圖最上層，透過 `mapRef.pointForCoordinate()` 換算螢幕座標定位。`npm test` 138/138 全過。**9/14 真機驗證（Android，發完 EAS Update 後）**：地圖正常顯示，未出現先前 SDK 57 那種空白/異常，店名標籤正確顯示在對應圖釘下方；已知限制是拖曳過程中標籤跟不上圖釘、放開手勢才追上，使用者實測確認可接受。
  - 第二版嘗試：真正的自訂 Marker（圖釘外觀本身客製化） [已放棄，還原回第一版] (9/14) — 使用者要求「跟 Web 版一樣客製化圖釘外觀」（圓形色塊＋文字，不只是外掛一行字），試著改回第一版刻意避開的那條路：`<Marker>` 直接塞自訂 `<View>`。**兩輪真機測試都失敗**：
    1. 第一次：地圖正常但所有圖釘完全不顯示。判斷是 `tracksViewChanges={false}`（社群常見的效能緩解手段）從第一次渲染就設 `false`，導致 Android 端跳過「把 View 拍成圖片」這個步驟，圖釘從未生成過圖片——這是 `react-native-maps` 另一個已知的坑，跟原本擔心的「New Architecture 顯示異常」是不同失敗模式。
    2. 移除 `tracksViewChanges={false}`（改回套件預設值）後**再測一次，圖釘依然不顯示**，證實問題不只是這個屬性的時機問題，是自訂 Marker 內容這條路徑本身在這支真機／這個 New Architecture 組合下就是不可靠——正好對應最早的風險評估。
    連續兩次快修都沒解決，且每次都要使用者重新實機測試、成本不低，判斷不宜再繼續猜測性嘗試，已把 `LiveMapScreen.native.jsx` 直接還原回第一版（文字疊層，commit `89b35d4`）並重新發布 EAS Update。**結論**：這個專案的 Android 環境（Expo 54 ＋ New Architecture）目前不適合用 `react-native-maps` 的自訂 Marker 內容，不管有沒有搭配 `tracksViewChanges`；店家標記客製化外觀就維持第一版的「原生圖釘＋外掛文字疊層」做法，不再嘗試真正自訂圖釘外觀，除非之後專案本身升級到有修好這個相容性問題的更新版本。
  - 圖釘配色改為紅／青／黃，網頁預覽同步成手機版樣式 [進行中] (10/3) — 手機版（`LiveMapScreen.native.jsx`）自己的位置用 Android 原生預設紅圖釘、沒有招募中團購的店用青色、有招募中團購的店用黃色，改成固定色（不再跟深淺色主題連動）；網頁預覽（`LiveMapScreen.web.jsx`）同步改成同樣的水滴圖釘、店名標籤加實心／空心小圓點、隱藏 Google 商店小圖示，自己的圖釘不再常駐顯示地點名稱。`npm test` 238/238 全過；網頁預覽已用使用者提供的截圖確認紅／青／黃圖釘、實心空心圓點、小圖示隱藏都正常（`docs/screenshots/live-map-web-pins-2026-10-03.png`）。**手機版圖釘新配色尚未在真機確認**，這一項在真機看過前維持進行中。
  > 目前地圖上的店家標記是水滴圖釘：紅色是自己的位置、黃色是有招募中團購的店、青色是沒有招募中團購的店，圖釘下方常駐店名文字（實心小圓點＝有團購、空心＝沒有）。手機版因 Android 原生圖釘只能指定色相，顏色是近似值；網頁預覽用同樣的水滴形狀與標籤，看起來與手機版一致。
- Android 地圖實機 E2E [待處理]
  > 拿真的 Android 手機把地圖相關功能從頭到尾操作一次，確認在真實裝置上沒問題，不只是在電腦上測試。
- 專題展現場網路（學校 Wi-Fi 擋 Google 地圖底圖） [完成] (10/4) — 使用者 10/4 回報學校網路下地圖已可正常顯示（放行方式與細節未記錄，只有這一句人工回報作為依據）。當初的狀況：10/1 組員的平板在學校 Wi-Fi 下，地圖只顯示粉紅空白底加店家圖釘（圖釘與店名是我們自己後端的資料，所以有；街道底圖是各裝置直接向 Google 要的，被擋）；換成自己的行動網路就正常。兩支裝置用的是同一份 APK，可排除金鑰設定問題。若換到別的場地或網路又被擋，處理方式（向網管申請放行 Google 地圖相關網域 `*.googleapis.com`、`*.gstatic.com`、`mt0`～`mt3.google.com`、先把展示範圍的地圖開過一遍暫存圖磚、準備地圖正常的錄影）見 `docs/azure-classroom-deployment.md` 的「專題展現場注意事項」。
  > 專題展要在學校辦，校園網路若限制 Google 地圖的流量，展示時地圖會看起來是壞的，需要事先排除或準備替代做法。

## 金流 [進行中]
> 所有跟「錢」有關的功能：顧客付款、退款、商家收到錢的整個流程。
- LINE Pay 付款 [進行中]
  > 用 LINE Pay（LINE 官方的行動支付服務）讓顧客付團購訂單的錢，是目前主要的付款方式。
  - 付款畫面與文案 [進行中]
    > 顧客／商家在畫面上看到的付款相關內容：付款流程本身的畫面、雙方看到的狀態文字說法。
    - Mobile 端 [完成] — 付款畫面、輪詢、deep link 回跳
    - 優先嘗試直接開啟 LINE App，退回瀏覽器才需要另外登入 [已還原] (9/16，當天實機發現問題後撤回) — 使用者提問「為何我按 LINE Pay 都跳瀏覽器要登入，別人的有些能直接跳進 LINE App」，查證後抽出共用函式 `openLinePayCheckoutUrl`，原生平台先嘗試 `paymentUrl.app`（LINE App 深層連結），打不開才退回 `paymentUrl.web`。當時的推測是「sandbox 連不到真實 LINE App，這個改動暫時不會有效果，等切正式環境才看得出差異」——**這個推測是錯的**：使用者實機測試（手機有安裝 LINE App）回報按「前往 LINE Pay 預授權」後跳進 LINE App，卻顯示「載入失敗」，付款卡住，跟推測完全不同。根因是 `Linking.openURL()` 只要「有 App 能處理這個網址」就算成功（不會 reject），跟「那個 App 真的能完成這筆交易」是兩回事——手機上裝了 LINE，Android 找得到 App 打開，`openURL` 就正常結束，完全不會進到「開不了才退回瀏覽器」那段容錯；但 LINE App 打開後發現這是一筆 sandbox 測試交易、不是真的綁在使用者帳號下的交易，處理不了，顯示自己的「載入失敗」畫面。等於這個改動把所有手機上有裝 LINE 的人，全部從原本能用的瀏覽器付款路徑，導向一個保證失敗的死路。已於當天撤回，改回一律使用 `paymentUrl.web`（`.app` 只在 `.web`不存在時才當備援），等專案真的切到正式 LINE Pay、有真實環境可以測試時才考慮重試。`npm test` 138/138 全過，已推送並發布 EAS Update。
    - 顧客／商家付款狀態文案分離 [完成] — `authorized` 顧客端顯示「訂單成立」、商家端顯示「已付款」；`failed` 商家端顯示灰色「待付款」。已加入 3 個 Mobile 文案契約測試，`npm test` 於 2026-08-15 實測共 42 項全數通過
      > 同一筆訂單的付款狀態，顧客看到的說法跟商家看到的說法不一樣（例如顧客看到「訂單成立」，商家看到「已付款」），避免同一句話讓兩邊誤會。
    - 付款狀態文案 Android UI 人工覆核 [待處理] — 尚未實際開啟顧客訂單／付款頁與商家訂單畫面確認最終排版；不可把自動測試視為 UI E2E
      > 拿真的 Android 手機實際打開訂單畫面，確認上面那些付款狀態文字排版顯示正常，不是只用程式測試檢查文字內容對不對。
    - 待付款訂單卡在「我的訂單」列表沒有付款入口 [完成] (8/25) — 真機測試發現：顧客送出訂單後若離開當下的付款頁（不論是不小心返回、還是單純先去逛逛），`order.paymentStatus === "pending"` 的訂單只有在剛送出訂單那一刻的自動導轉才碰得到付款畫面；之後從「我的訂單」列表點進同一筆訂單，[CustomerOrdersScreen.jsx](mobile/src/screens/CustomerOrdersScreen.jsx) 的 `OrderDetailCard` 原本只在 `paymentStatus === "failed"`（扣款失敗）跟 `reauthorizationReason === "order_amount_changed"`（金額變動）這兩種情況給重新付款的按鈕，從未授權過（單純 pending）的訂單完全沒有對應按鈕，只顯示「待付款」文字說明，等於卡死。已補上「前往付款」按鈕，導向既有 `paymentAuthorization` 畫面；Web 預覽以真實測試帳號重現整個情境（送出訂單→離開→從訂單列表重新進入→點「前往付款」→正確進入付款畫面且可正常操作）驗證通過，`npm test` 77/77 全過
      > 顧客訂單送出後如果沒有馬上付款、之後想從「我的訂單」回來繼續付，原本沒有任何按鈕可以按，只看得到一句「待付款」的說明文字，等於卡住。
    - 顧客按了「前往付款」卻永久卡在「已有一筆進行中」 [完成] (8/29) — 真機測試發現：顧客開啟 LINE Pay 頁面後若未完成就退出 App，再點「付款」會被 [linePayService.js](backend/payments/linePayService.js) 永久擋下 409 `authorization_already_pending`，因為 LINE Pay 沒有提供「主動取消尚未確認的付款請求」API，只能等 LINE Pay 自己判定過期（等待時間未公開，查證過官方文件確認查無此資訊）。與使用者來回討論多輪、比較三種自訂逾時方案的風險後，改採「顧客重試時直接放棄舊的、建立新的」（參考真實上線 App 的作法），不額外設等待時間。安全性建立在既有的 `confirmLinePayAuthorizationUnlocked` 守門機制上：即使顧客事後回頭完成舊頁面，後端也會先檢查本地紀錄是否仍是 `pending` 才會呼叫 LINE Pay 正式確認，一旦已標記失敗就直接拒絕，不會產生顧客不知情的授權扣款。新舊訂單與改單（order revision）付款請求共用同一套邏輯。新增 1 個自動化測試驗證「先放棄舊的才建立新的」順序正確，`npm test` 93/93 全過，並完成一次安全審查（見 `docs/AI-security-review-log.md` 2026-08-29）。**尚未實機走過真實 LINE Pay 沙盒環境驗證**（開啟付款→退出→重新點付款→應拿到全新付款頁面），需要真機測試
      > 顧客點了付款、跳去 LINE Pay 但還沒完成就跳出來，回到 App 想重新付款時，系統應該讓他順利拿到新的付款畫面，而不是永遠卡在「已經有一筆在處理中」動彈不得。
    - 未付款訂單永遠卡在「進行中」、且截止後仍能發起新付款 [完成] (8/29) — 使用者回報有一筆從未點過付款的訂單，對應團購早就截止卻仍未出現在歷史訂單，追查後修好兩個獨立缺口：(1) [linePayService.js](backend/payments/linePayService.js) 的 `requestLinePayAuthorization` 完全沒有檢查團購截止時間，截止後仍能發起新的 LINE Pay 付款請求；已補上檢查，截止後回傳 `activity_deadline_passed`，Mobile 端顯示「這個團購已經截止，無法再付款。」(2) [getOrderLifecycleBucket](backend/db.js) 判斷「進行中／歷史」分類時，沒有處理「從未發起過付款」（`paymentStatus` 一直是 `pending`）的訂單，導致永遠留在進行中；已在截止結算（[groupBuySettlementRepository.js](backend/database/repositories/groupBuySettlementRepository.js) 與 SQLite 對應的 `createGroupBuySettlementPlan`）補上一步，把這類訂單標記為已取消，比照既有商家/顧客取消訂單的欄位組合（`status`／`pickup_status`／`merchant_acceptance_status` 皆設為 `cancelled`，付款狀態維持 `pending`），使其正確歸入歷史訂單。新增 2 個 `linePayService` 自動化測試（截止前／截止後各一）與 1 個 `group-buy-settlement-repository-smoke` 測試場景，`npm test` 95/95、smoke 測試全過，並完成一次安全審查（見 `docs/AI-security-review-log.md` 2026-08-29）。**尚未實機驗證**：需要真的等一個團購過期且有未付款訂單，確認它正確移入歷史訂單
      > 團購過了截止時間後，理論上不該再讓人付款，也不該有訂單永遠卡在「進行中」看不到——這次把這兩個漏洞一起補上。
  - 核心請款流程 [進行中]
    > 顧客真正付款、系統處理這筆付款的核心邏輯，以及確保這個流程本身正確無誤的把關。
    - Backend 端：付款六階段處理模組 [完成]
      > 後端處理付款每個階段的邏輯：發起付款請求、確認付款、取消、正式請款、作廢預授權、退款，對應信用卡/行動支付標準流程的六個步驟。
    - 付款前取餐／逾期未取規則同意 [進行中]
      > 顧客付款前，要先讀過並勾選同意「取餐、逾期沒來拿怎麼處理」的規則，才能繼續付款，避免事後糾紛。
      - Mobile 與 Backend 串接 [完成] — 顯示 Backend 現行全文／版本，未勾選不能付款；Backend 保存 `order_rule_consents` 後才呼叫 LINE Pay
        > 手機畫面顯示的規則同意內容，跟後端實際存的規則版本要對得起來，確保顧客看到的、簽的，跟系統記錄的是同一份。
      - SQLite 與 PostgreSQL schema [完成] — SQLite runtime + PostgreSQL `005` migration
        > 存放「顧客同意了哪個版本的規則、什麼時候同意的」這筆紀錄的資料表格式。SQLite 是開發階段先用的輕量資料庫，PostgreSQL 是之後正式上線要換成的正式資料庫，兩邊格式要對齊。
      - 自動測試 [完成] — 缺少／過期同意、保存失敗、管理員代同意與 SQLite append-only／完整性已驗證
        > 針對「顧客有沒有同意規則」這件事寫的自動化檢查，確保沒同意就不能付款、同意紀錄不會被竄改或搞丟。
      - Android + LINE Pay sandbox 人工 E2E [完成] (8/25) — 8/15 已驗證 Android 長文排版、未勾選停用、勾選後送出、抵達 LINE Sandbox 登入頁；8/25 補上剩下的部分：真機輸入 LINE Pay Sandbox 測試帳密、完成授權 confirm、App 正確回跳。已用真實 PostgreSQL 資料查證整條鏈：`order_rule_consents` 存了 1 筆 v1.0 規則全文快照（consented_at 05:15:15）→ `payment_authorizations` 狀態為 `authorized`（provider `line_pay`、真實 sandbox `provider_authorization_id`、authorized_amount 與 original_amount 一致、authorized_at 05:15:33）→ 訂單狀態 `submitted`，對應團購活動仍在 `recruiting` 且未過截止時間，確認這筆訂單真的算進團購。首次完整跑通「同意規則 → 付款」全流程，可視為完整付款 E2E
        > 拿真的 Android 手機，搭配 LINE Pay 提供的測試環境（sandbox，不會真的扣錢），把「同意規則 → 付款」整個流程走一遍，確認真的能動。
    - 分離式請款 Sandbox 人工端對端驗證 [完成] (8/8，8/25 補一筆真機起單的驗證) — docs/line-pay-separated-capture-sandbox-checklist.md LP-01/02/04/07/08/09/10 全數通過；8/25 額外用開發控制台把模擬時間快轉過活動截止時間，讓結算排程對上面那筆「真機下單→授權」的真實訂單觸發正式請款，確認 `payment_authorizations` 轉為 `captured`、`payment_captures` 產生對應紀錄（`capture_amount` 425 與授權金額一致、真實 sandbox `provider_capture_id`），驗證完畢已把模擬時間恢復為真實時間
      > 「分離式請款」是先跟顧客的付款方式預先鎖定一筆錢（預授權），確定要出餐了才正式請款、真的把錢請進來，不是付款當下就直接扣款——這裡是拿 LINE Pay 的測試環境把這整套流程實際跑過一次確認沒問題。
    - 主要請款流程缺少建立失敗檢查 [完成] (8/20) — 補上 `null` 檢查，改為明確回傳 409 錯誤而非靜默的假成功；`npm test` 59/59 與相關 smoke test 全過
      > 顧客發起付款請求時，如果因為某些原因（例如金額跟訂單當下不符）沒能真的建立付款預授權，系統目前不會發現、還是會告訴顧客「已經建立成功」，這會誤導顧客。
    - 團購優惠改成百分比折扣（打幾折） [完成] (9/18) — 原本「滿N杯折固定金額」改成「滿N杯打幾折」；折扣百分比存在 `promotion_tiers.discount_percent`（1-99 整數），結算時每筆訂單各自依自己的原價計算應付金額（`ceil(原價 * (100-折扣%) / 100)`，無條件進位、進位方向有利商家），不再是「一包金額先平分、尾差退商家」的舊制。新增 PostgreSQL migration `008`（不相容變更，套用前須先清空 `group_buy_activities`），同步改寫了後端三份原本重複的折扣/結算邏輯（PostgreSQL repository、SQLite 相容路徑、Mobile 端預估顯示）與商家建立活動的輸入介面（「打幾折」支援小數點一位，例如 7.9 折）。百分比折扣對非負價格數學上不可能讓應付金額變負，一併移除了幾個只為舊制「金額折扣會不會讓價格變負」設計的驗證函式。`npm test` 146/146 全過；本機真實 PostgreSQL 走過一次乾淨的單一結算情境（活動打 7.9 折、訂單原價 $65），確認 `orders.final_amount`／`payment_captures.capture_amount` 正確寫入 $52（`ceil(65*0.79)`）。已完成一次 `/security-review`，未發現問題，見 `docs/AI-security-review-log.md` 2026-09-18。**尚未做**：對應的 smoke test script（約 12-13 支，fixture 仍寫死舊的 `discountAmount` 欄位）尚未同步更新；Azure 展示環境尚未套用這次 migration，需要使用者自行清空該環境的 `group_buy_activities` 後才能套用。
      > 團購的優惠規則從「滿N杯折固定金額」改成「滿N杯打幾折」，結算時依每筆訂單自己的金額算折扣，不是整包金額平分。
  - 背景可靠性機制 [進行中]
    > 不是顧客/商家直接操作的部分，是系統自己在背後定期檢查付款有沒有卡住、需不需要重試或通知人處理的機制。
    - 付款對帳與自動重試機制 [完成] (7/30)
      > 系統會固定去跟 LINE Pay 對帳，確認雙方紀錄一致（目前只處理 LINE Pay，ECPay 還沒有這套對帳機制）；待處理的對帳工作會存進一個不會因為程式重啟而消失的工作清單（持久化工作佇列），並用「借用鎖」機制（lease-based claim）確保同一筆工作不會被重複處理兩次。
    - 付款背景工作失敗告警日誌 [完成] (8/15) — 函式位於正確模組層級，已補 2 個單元測試驗證只輸出 `alertRequired` 工作；正式外部通知管道仍待處理
      > 如果有付款相關的背景工作卡住失敗到無法再重試（terminal，代表已經到終點、放棄重試），系統會記一筆警示日誌，方便之後排查是哪裡出問題。
    - 付款結算自動化檢查 [完成] (7/19) — `npm run settlement:smoke`
      > 一個可以快速執行的自動化檢查腳本，用來確認付款結算功能的核心流程沒有壞掉。
    - 正式告警通知管道 [完成] (8/24) — 新增 `backend/payments/alertNotifier.js`，LINE Pay 對帳排程與結算排程在既有的結構化警示日誌之外，同步呼叫可設定的 `ALERT_WEBHOOK_URL`（通用 webhook，Slack／Discord／Mattermost 的 incoming webhook 都吃同樣的 JSON 格式；不設定就完全不送、不報錯，sandbox/dev 環境本來就不會設）；排程本身丟例外（整個排程掛掉，不是單一工作失敗）也會觸發同一支通知。`/security-review` 抓到一個中風險問題並已修：結算排程失敗時原本會把整個團購活動所有訂單的明細（顧客 ID、金流交易序號、金額）原封不動送到外部 webhook，現在送出前會摘要化成筆數，不再外流逐筆明細。7 個單元測試（含這次修復的驗證）與既有測試共 77/77 全數通過，詳見 `docs/AI-security-review-log.md` 2026-08-24 追加的那筆
      > 上面提到的警示日誌，原本只會寫進系統紀錄裡，要有人自己去翻才看得到；現在補上一個可以接 Slack 之類工具的管道，出事會主動推播，不用等人發現。
- 商家退款申請 [進行中]
  > 顧客要退款時，由商家在後台提出退款申請，經過審核（核准或駁回）才會真的退錢，不是顧客自己就能直接退款。
  - Backend 端 [完成] (8/4) — 申請／審核 API（pending/approved/rejected），`npm run refund-request:smoke` 涵蓋申請、重複阻擋、核准、駁回
  - Mobile 端：商家申請 UI [進行中] — `MerchantRefundRequestsScreen` 已接 API 且 navigation 可到達；尚未有 Android／真實 provider E2E 證據
    > 商家在後台看到、提出退款申請的畫面。
  - 管理員審核網頁後台 [完成] (8/22) — 原本的 `AdminRefundRequestsScreen`（手機 App 裡的開發用畫面）已移除，審核功能改在獨立的 `/admin/refund-requests` 網頁後台（見下方「管理員網頁後台」）；核准／駁回直接重用既有 `approveRefundRequest`／`rejectRefundRequest` 服務層函式，未改動審核邏輯本身
    > 平台營運人員審核退款申請、決定核准或駁回的網頁畫面，跟顧客/商家用的手機 App 是分開的。

## 訂單流程 [進行中]
> 顧客下單之後，訂單會經過的每個階段：選飲料、修改訂單、取貨、逾期沒取怎麼處理。
- 截止後最終結算結果 [完成] (8/15)
  > 團購活動截止之後，系統會依照最後湊到的總杯數重新算一次正確的折扣跟金額，這是每張訂單最後確定要付多少錢的依據。
  - Backend 活動 API [完成] — SQLite／PostgreSQL 都回傳不可變 `settlement` 快照
    > 提供「這個團購活動最後結算結果是多少」這筆資料的後端介面，讓手機 App 可以查詢顯示，而且這筆結果一旦算出來就不會再變動。
  - Mobile 團購進度 [完成] — 顯示最終有效杯數、最終每杯折扣、訂單實際應付、訂單折扣與未分配尾差
    > 手機畫面上顯示這次團購目前/最終的進度：湊了幾杯、折扣打幾折、自己這筆訂單實際要付多少錢。
  - 「目前進度」分母顯示錯誤級距，杯數超過第一級距後變成「30 / 20」[完成] (9/15) — 使用者截圖回報團購詳情頁「目前進度」顯示「30 / 20 杯」，看起來像超過上限。查證後發現 `groupBuyActivity.targetCups` 這個欄位（見 [groupBuyActivityReadRepository.js](backend/database/repositories/groupBuyActivityReadRepository.js)）後端定義固定是「第一個優惠級距的門檻」，不是活動上限；[GroupBuyActivityDetailScreen.jsx](mobile/src/screens/GroupBuyActivityDetailScreen.jsx) 與 [GroupProgressScreen.jsx](mobile/src/screens/GroupProgressScreen.jsx) 兩個畫面都直接拿這個欄位當進度條分母，一旦已授權杯數衝過第一級距（此例：第一級距 20 杯，實際已達 30 杯級距），分母沒有跟著換成「下一個還沒達到的級距」或「最高級距」，就會出現分子大於分母、看起來像超賣的畫面。首頁附近推薦列表（`NearbyGroupBuyActivitiesScreen.jsx`）其實早就有一個算對的共用函式 `getGroupBuyActivityProgress`（`mobile/src/utils/groupBuyActivityProgress.js`），只是這兩個畫面沒有共用到，`GroupProgressScreen.jsx` 甚至自己另外重寫了一份邏輯、fallback 順序還寫錯（沒過任何一級距時會先退回第一級距門檻，而不是最高級距）。修法是讓這兩個畫面都改用同一個已驗證過的共用函式，不再各自維護。純顯示邏輯調整，不影響杯數、金額、授權或後端資料。`npm test` 138/138 全過，Expo Web 重新 bundle 無報錯，已推送並發布 EAS Update。**尚未實機驗證**：需要使用者在真的超過第一級距的團購上確認分母正確顯示為下一級距或最高級距。
  - 自動測試 [完成] — 最終快照資料契約與 PostgreSQL read repository smoke 已通過
    > 針對「團購結算完之後金額資料對不對、讀得到讀得對」寫的自動化檢查。
  - Android UI 人工覆核 [待處理] — 尚未由使用者在模擬器檢查小螢幕排版
    > 拿真的 Android 手機（尤其是小螢幕機型）實際打開畫面確認排版正常，還沒有人做過這個檢查。
- 菜單與購物車 [完成]
  > 顧客選飲料、客製化（甜度冰塊等）、加進購物車、送出訂單的整個流程。
  - 顧客權威菜單 API 與客製化選項 [完成]
    > 顧客實際看到、可以選的菜單跟客製化選項（例如甜度、冰塊、尺寸），一律以後端資料為準，不能只靠手機自己存的舊資料。
    - Mobile 端 [完成] — `StoreMenuScreen`／`DrinkSelectionScreen` 已改讀後端菜單
    - Backend 端 [完成]
  - 商家菜單管理 [完成]
    > 讓商家自己在後台編輯自己店裡的菜單、品項跟選項。
    - Mobile 端 [完成] — 商家菜單管理畫面
    - Backend 端 [完成] — 菜單管理 API
  - 管理員批次匯入／取代菜單 [完成] (9/17)
    > 新店家第一次要上架菜單時可能有 50-60 個品項，一個一個透過商家自己的「菜單管理」畫面輸入太慢；這個功能讓管理員在後台 `/admin/stores/:storeId/import-menu` 貼上兩段整理好的表格文字（品項清單、客製化選項），一次寫入整份菜單。也支援對已經有菜單的店家重新匯入：舊品項會被下架（不是刪除，避免影響已經下單過的歷史訂單），畫面上看起來就是整份菜單被換成新的，需要額外勾選確認框才會執行。
    - 已用本機真實 PostgreSQL 資料庫端對端驗證：對全新空店家匯入 3 筆品項（含甜度／冰量／尺寸／加料客製化選項），品項、客製化規則、選項、audit log 逐欄核對皆正確；對一間**真的有歷史訂單**的既有店家（`store-001`，2 個品項各有 5 筆與 2 筆歷史訂單明細）重新匯入，確認舊品項正確下架、歷史訂單明細完全未受影響、新品項正確寫入，且沒有勾選確認框時會被擋下；格式錯誤時會列出每一列問題並保留使用者貼上的內容。測試後已還原資料庫至原狀。`npm test` 138/138 全過。尚未寫自動化單元測試，也還沒有人在真的核准商家申請後，走「核准→匯入」這條完整路徑操作過。
    - 「我了解，取代目前的菜單」確認框勾了也送不出去 [完成] (9/26) — 使用者實際匯入時，勾選後仍一直顯示「請勾選確認框」。原因是確認框畫在表單外面，瀏覽器不會把表單外的欄位一起送出，後端永遠收不到，所以**所有已經有菜單的店都無法匯入**；先前只驗證過「全新空店家」與資料庫層，沒有從網頁走過這一關。修法是給表單一個 id、讓確認框用 `form` 屬性歸屬到該表單（[server.js](backend/server.js) 的 `renderAdminMenuImportBody`）。已在真實瀏覽器重現（修前勾了仍不送出、修後送出 `on`；沒勾時仍不送出，安全檢查沒有被繞過），並用一家暫時建立的店把實際要給使用者貼的 12 個品項、116 個選項走完整個匯入流程（12 筆寫入、2 筆舊品項下架、選項與選擇規則正確，測完全部刪除）。**尚未做的**：Azure 上要重新部署後端才會生效；沒有自動化測試（`server.js` 的畫面函式目前沒有單元測試的做法）。
      > 已經有菜單的店家，管理員在匯入頁勾選確認後，才能把整份新菜單換上去。
    - 入口易發現性補強 [完成] (9/17) — 原本「匯入菜單」連結只放在「商家申請審核」頁已核准清單旁，使用者實際操作後回報：完全沒有商家申請紀錄時（例如目前的 Azure 課堂展示環境），這個入口就無處可點；而且就算有申請紀錄，這個連結掛在「團購活動」列表（`/admin` 首頁）也不合理，因為一間剛核准、菜單都還沒匯入的新店家還沒有任何團購活動、不會出現在那頁。改在「帳號角色」頁（`/admin/accounts`，列出所有帳號不受申請或活動紀錄影響）的每個商家帳號旁加上同樣的「匯入菜單」連結。已用瀏覽器確認 7 個 seed 商家帳號旁都正確出現指向各自 `storeId` 的連結。
  - 購物車客製化摘要（含尺寸） [完成] (8/9)
    > 購物車畫面上要清楚列出每一杯飲料選了哪些客製化選項（含尺寸），不能只顯示品項名稱。
  - 訂單建立／更新驗證（防竄改、防超賣、快照） [完成]
    > 訂單送出或修改時，後端會重新檢查金額、庫存有沒有問題，防止有人竄改價格、防止賣超過店家能出的量，並把當下的訂單內容存一份不會再變動的快照，之後結算都以這份快照為準。
- 訂單修改（Revision） [進行中]
  > 訂單送出之後，顧客如果想改內容（例如換飲料），系統怎麼處理這次修改。
  - 改單與重新預授權 [進行中]
    > 顧客修改訂單內容時，因為金額可能變了，系統要重新跟顧客的付款方式做一次預先鎖定金額的動作（重新預授權），確保之後真的請款得到錢。
    - Mobile 端 [完成] — 購物車／訂單明細修改觸發 revision，付款頁帶 `orderRevisionId`
    - Backend 端 [完成] — `POST /api/orders/:orderId/revisions` 建立 pending revision
    - 加購時既有品項被靜默蓋掉 [完成] (9/15) — 使用者回報「已下第一單後想加購，第二次沒有跳出 LINE Pay」，追查後發現不是付款頁沒出現，而是「修改訂單」流程本身有資料正確性問題：`order_revisions` 與待授權訂單的更新 API 後端都是整批替換品項清單（跟建立全新訂單同一套合約），但 [AppNavigator.js](mobile/src/navigation/AppNavigator.js) 的 `submitCart` 只把購物車裡這次新選的品項送出去，沒有把訂單既有的品項一併帶上，導致改單成功後既有飲料被靜默移除、只剩新加的那杯——這才是使用者實際感受到「怪怪的、不像有效加購」的根因。修法是送出前把 `existingOrder.items`（既有品項）與購物車新品項合併成完整清單再送後端，`updateOrderItems`（訂單明細頁的單筆刪除）本來就是用這種「合併後的完整清單」寫法，這次讓「修改訂單」共用同一套合約。順帶修正一個因此曝露的既有容量預檢公式錯誤：合併前的公式假設購物車內容就是訂單新總量，合併後這個假設不成立，改為已授權訂單用純新增杯數、待授權/全新訂單用合併後總杯數。已用本機真實 PostgreSQL 手動操作驗證兩次（新增 1 杯不同品項＝ $105／2 杯；新增 3 杯＝ $235／4 杯），確認 `order_revisions` 正確保留原品項＋新品項、金額與杯數皆正確、未誤觸容量預檢；`npm test` 138/138 全過，並完成一次安全審查（見 `docs/AI-security-review-log.md` 2026-09-15）
  - 失敗提示細化 [完成] (8/27) — `getOrderWriteErrorMessage`（新抽成 `mobile/src/utils/orderWriteErrors.js`，`createOrder`／`updateOrder`／`createOrderRevision` 共用）原本只認得 2 種 backend 錯誤代碼、其餘一律顯示英文原始代碼，這次補齊改單會遇到的全部 8 種（`order_not_revisable`／`activity_not_joinable`／`order_locked_by_deadline`／`order_revision_already_pending`／`order_authorization_missing`／`capacity_exceeded`／`order_not_found`／`order_access_denied`）與另外 3 種建單/更新共用代碼，全部改成具體中文提示；`order_locked_by_deadline` 會帶入實際截止時間。新增 9 個單元測試，`mobile` 測試套件 34/34 全過
    > 如果改單失敗（例如重新預授權失敗、團購快截止被鎖定），原本畫面只會顯示後端回傳的英文錯誤代碼，現在改成看得懂、知道具體原因跟該怎麼辦的中文提示。
  - 改單替換舊授權未接上 PostgreSQL repository [完成] (8/20) — 補上 `authorizationCancelRepository` 注入（含撤銷成功與撤銷失敗兩條路徑）；`npm test` 59/59 與 `settlement:smoke`（涵蓋改單替換授權情境）全過
    > 顧客改單、系統要用新的付款授權取代舊的時，撤銷舊授權這個步驟目前不管資料庫設定是什麼，都固定寫進 SQLite；如果之後改單功能真的切到 PostgreSQL，這裡會出現資料寫錯資料庫的問題。
- 取貨與逾期 [進行中]
  - 單筆訂單標記可取餐 [進行中] (9/13) — 已串接商家按鈕、請求與取餐資料存取；6 項隔離單元測試通過，涵蓋訂單範圍、商家權限、重複標記與共用活動鎖。Mobile 語法解析通過；已驗證真實 PostgreSQL 單筆憑證回傳（交易回滾）。單筆改用獨立網址，避免舊後端忽略參數而整批更新，本機後端已重啟；17 項相關測試通過；真實 PostgreSQL 三筆訂單逐筆標記、重複標記、部分取餐、後續整批與完成流程通過，交易回滾後資料與原快照一致。尚待完整 HTTP／Android 操作驗證。
    > 店家可依各筆訂單的製作進度個別開放取餐，其他訂單繼續等待，也保留全部標記功能。
  - SQLite 相容路徑的 lease 鎖定判斷漏傳模擬時間 [完成] (9/14) — 驗證 `npm run pickup-credential:smoke` 時發現「activity lease should block ready transition」這個斷言持續失敗；根因是 `credentialService.js` 的 SQLite 相容路徑呼叫 `withOperationLeaseSync` 標記可取餐／核銷取貨碼時，沒有把呼叫端傳入的模擬時間（`input.now`，測試與開發控制台用來模擬「現在幾點」）轉傳給 lease 機制，導致過期判斷退回真實系統時間，跟其餘轉換邏輯用的時間基準對不上，鎖被誤判成早已過期、擋不住並發轉換。修法是補傳 `now: input.now`，只動 SQLite 相容路徑，未碰 Postgres repository。已獨立重新驗證：`npm run pickup-credential:smoke` 全數通過（含 `ready_transition_blocked`／`redeem_transition_blocked`）、`npm test` 138/138 全過，並完成一次 `/security-review`（見 `docs/AI-security-review-log.md`）。原本在另一個 session 的獨立分支上修復，9/14 已合併進 `main`。
    > 商家標記訂單可取餐或核銷取貨碼時，系統會先鎖住這筆活動避免兩個操作同時衝突；這個鎖原本在測試模式下判斷「有沒有過期」用錯了時間基準，可能讓鎖形同虛設。
  > 顧客到店取餐、以及超過時間沒來取餐的處理流程。
  - 取餐核銷查無飲料明細、顧客端取貨狀態不會自動更新 [完成] (9/17) — 使用者實機回報三個現象：(1) 商家輸入六位取餐碼查詢後，卡片只顯示顧客名稱、杯數與金額，沒有列出實際要準備哪些飲料；(2) 商家核銷後，顧客那邊已開啟的訂單明細畫面仍停在「已付款」、還顯示舊的取餐碼，不會自動變成「已取餐」；(3) 核銷後的訂單在顧客「我的訂單」找不到。逐一查證：(1) 是真的缺口，`findMerchantCredentialPostgres` 的查詢從未 join 訂單品項，`mapMerchantCredential` 回傳也沒有 `items` 欄位；已補上（重用 `customerOrderReadRepository.js` 既有的 `getPostgresOrderDetail`），並把商家端專用的 `toLocalOrderItem` 轉換函式從 `AppNavigator.js` 搬到共用的 `mobile/src/utils/orderItems.js`，讓 `MerchantDashboardScreen.jsx` 正確渲染每項飲料的甜度／冰塊／加料。過程中發現 `redeemCodePostgres` 在交易內用 `Promise.all` 平行查詢品項會觸發 `pg` 的 deprecation warning（單一交易連線不支援平行查詢），改成交易 commit 後才查（品項是訂單建立當下的不可變快照，交易後查沒有時間差風險）。(2) 也是真的缺口：`CustomerOrdersScreen.jsx` 選定訂單後只在剛選取那一刻同步一次，畫面開著之後沒有任何機制知道商家在別的裝置核銷了——已補上：當前訂單有效取餐碼時，每 5 秒輪詢一次（上限 5 分鐘），核銷後自動停止。(3) 查證後**不是 bug**：「進行中」「歷史訂單」是分開延遲載入的兩個分頁，`useOrderListSync` 只在切換分頁時才重新抓，所以剛完成的訂單在還沒點過「歷史訂單」分頁前本來就不會出現在任何一邊，點進去就看得到，沒有改程式碼。已用兩個獨立瀏覽器分頁模擬商家／顧客兩台裝置，對真實 PostgreSQL 端對端驗證全部三點：商家查詢正確列出兩項飲料與客製化內容；核銷後顧客那個完全沒手動操作、開著不動的畫面在輪詢週期內自動變成「已取餐／店家已完成核銷」；訂單在點開「歷史訂單」分頁後正確顯示「此訂單已完成」。`npm test` 138/138、`pickup-credential-postgres:smoke` 通過（交易重構後 deprecation warning 也確認消失）。已推送並發布 EAS Update。順手發現同一個檔案「待製作明細」區塊有相同類型的客製化顯示問題（未走 `toLocalOrderItem` 正規化），這次沒有動它，已另外開一個背景任務建議處理。
    > 商家用取餐碼查訂單時看不到要準備的飲料，顧客核銷後畫面也不會自動更新，兩者都補上了；訂單一時看不到不是 bug，只是「歷史訂單」要點過一次才會去抓資料。
  - 取貨憑證建立／驗證／逾期排程 [完成] — `npm run pickup-expiration:smoke` 驗證
    > 顧客取餐時要出示的憑證（類似取貨碼），系統會產生、驗證這張憑證是否有效，並自動排程檢查有沒有訂單超過取貨時間還沒被領走。
  - Android 實機 E2E [待處理]
    > 拿真的 Android 手機把取貨、逾期提示的整個流程實際操作一次確認沒問題。
- 顧客端推播通知 [進行中] (9/30)
  > 跟顧客的訂單與錢有關的結果發生時（成團、沒成團、改以原價購買、扣款失敗、團購被取消、飲料可以領取、取餐時間快結束），主動推播通知顧客的手機，不用顧客自己打開 App 才知道。維運警報（LINE Pay 對帳失敗等）走既有的 `ALERT_WEBHOOK_URL` 通用 webhook，跟這個顧客端推播是分開的兩件事，見 `docs/open-questions.md`「一致性與營運」表。
  - 後端事件觸發與 Expo 推播模組 [完成] (9/30) — 新增 `push_tokens` 資料表（`009_push_tokens_postgres.sql`）與對應 repository、`backend/notifications/pushSender.js`（直接呼叫 Expo push service，風格比照既有 `alertNotifier.js`：失敗不拋例外、記結構化日誌，不會讓結算或取貨這種核心流程被推播失敗拖垮）。兩個觸發點：結算成團時（`settlementService.js`，只有真的剛完成結算的那次會通知，重試遇到已完成的結算不會重送）、商家標記可取餐時（`credentialService.js`／`pickupCredentialRepository.js`，只有真的從「未可取」轉成「可取」的訂單才會通知，重複標記已可取的訂單不會再發）。過程中補上兩個既有欄位缺口：`groupBuySettlementRepository.js` 的 `mapActivity()` 原本沒有回傳 `title`、標記可取餐的查詢原本沒有帶出 `customer_user_id`，通知文案需要這兩個欄位才寫得出來。22 項新增單元測試（fake-DB，含 SQL 語句、顧客去重、結算重試不重複通知、內部欄位不外洩到 HTTP 回應等斷言）與既有 `npm test` 233/233 全數通過。
    > 團購成團或訂單標記可取餐這兩個時間點，後端自動呼叫 Expo 的推播服務把訊息送到顧客手機。
  - Mobile 端取得並註冊裝置 [完成] (9/30) — 新增 `expo-notifications`（原生依賴）、`mobile/src/utils/pushNotifications.js`（要權限、註冊裝置、失敗一律靜默不中斷登入，比照既有 `authSession.js`／登入時定位權限請求的寫法），登入成功時（`AppStateProvider.jsx` 的 `selectRole`，涵蓋重開 App 自動登入與手動登入兩條路徑）顧客角色會嘗試註冊。已用 Expo Web 預覽實際走過本機開發模式登入流程，確認不影響登入、無新增錯誤（web 平台本來就不支援推播，直接略過，不會呼叫原生 API）。
    > 顧客登入時，手機會在背景、不打斷操作的情況下跟後端登記這台手機可以接收推播。
  - 結算結果／團購取消／取餐截止提醒的通知 [完成] (10/4) — 結算在完成時依本輪每筆訂單的實際結果分成多種通知（`buildSettlementNotifications`）；取消團購在實際取消成功的訂單上通知（作廢失敗的不通知，已請款的不在取消名單內）；取餐提醒掛在既有取餐逾期排程上，距離取餐窗口結束 30 分鐘內（`PICKUP_REMINDER_LEAD_MINUTES`，0＝關閉）對「已可領取但未領」的訂單推一次，用新欄位 `orders.pickup_reminder_sent_at`（`010_order_pickup_reminder_postgres.sql`）認領去重。`npm test` 257/257 通過（新增 19 項，含 `/code-review` 三項發現的修正：結算重試時從訂單最終狀態決定通知對象、提醒送不出去會記錄、提醒時間可用小數）、`check:sql-safety` 通過；新 SQL 已在真實 PostgreSQL 的一次性 schema 跑完 migration 001–010 後驗證（認領 2 筆、再認領 0 筆、取消／未可領取／窗口外的訂單不被認領），驗證後 schema 已刪除。安全審查見 `docs/AI-security-review-log.md` 2026-10-04。**尚未實機收到推播**（見下一項）。
    > 在原本「成團」「可領取」兩種通知之外，補上顧客同樣需要知道的結果：團購沒成團（預授權已取消、不會扣款）、沒成團但依設定改以原價購買、單筆扣款失敗、團購被商家或管理員取消，以及飲料已可領取但取餐時間快結束時的提醒。
  - migration 009、010 套用到開發資料庫與 Azure [完成] (10/4) — 本機開發資料庫與 Azure 資料庫（`drinkgroupbuy-demo-hc`，PostgreSQL 16.15）都已套用到 010（009 兩邊先前就已存在）。兩邊套用前都先 `pg_dump` 備份，套用後 7～8 張主要表筆數前後完全一致，新欄位 `orders.pickup_reminder_sent_at` 存在。Azure 連線用完整憑證驗證；套用時需臨時在 Azure 防火牆放行執行電腦的 IP，用完應刪除該規則。
    > 推播功能用到的資料表（`push_tokens`）與訂單新欄位（`orders.pickup_reminder_sent_at`）要在每個實際使用的資料庫裡建立，後端才能存裝置、記錄提醒過的訂單。
  - Android 實機推播驗證 [進行中] (10/5) — 10/4 已重新打包含推播原生模組與 Firebase 設定的 release APK（`mobile/android/app/build/outputs/apk/release/app-release.apk`，簽章 SHA-1 `5E:8F:16:06:...:F6:25` 與先前相同，Google 登入不受影響；已確認 APK 內含 `expo-notifications`、`google_app_id` 等 Firebase 設定、`POST_NOTIFICATIONS` 權限，JS 內沒有展示模式旗標、後端網址為 Azure）。FCM V1 金鑰（Firebase 服務帳戶）10/4 已用 `eas credentials` 上傳並指派給 `com.drinkgroupbuy.prototype`（CLI 回報 Uploaded 與 assigned）。**實機已驗證**：裝上 `1004.apk` 的 Android 手機登入顧客帳號時跳出通知權限詢問，允許後 Azure 資料庫的 `push_tokens` 多了一筆該裝置紀錄；對該裝置手動送兩則測試推播（Expo 回報 ticket／receipt 皆 ok），使用者確認兩則都收到，且收到時 App 是完全關閉的狀態；App 在背景時也收到。**App 在前景時原本收不到**（連送三則都沒顯示）：程式沒有設定 `Notifications.setNotificationHandler`，Android 預設在 App 開著時不顯示通知；10/5 已補上前景顯示橫幅（`shouldPlaySound` 必須為 true，否則 Android 不跳出下拉提示），透過 EAS Update 發布，更新套用後實機確認前景會跳出橫幅。完全關閉、背景、前景三種狀態都已實機確認。**還沒驗證**：真實流程觸發的通知（結算成團／未成團、團購取消、可領取、取餐截止提醒）端對端送到手機。
    > 前景、背景、App 完全關閉三種狀態下是否真的收到系統推播通知，以及通知權限詢問畫面的實際體驗，都還沒有拿真的 Android 手機測過——這項功能新增了原生依賴，必須先重新打包 APK（單純的 EAS Update 無法讓這類改動生效）才能在實機上測試。
- 商家訂單展開與總製作清單 [進行中] (9/13) — 待製作訂單預設收合，展開後逐項顯示飲品、數量、客製化及單筆標記按鈕；總製作頁維持相同配方合併，排除已可取餐、已取餐、取消與逾期訂單。兩個畫面 Babel 語法解析通過，尚待實機確認展開／收合與導覽。
  > 店家能分別查看每筆訂單的飲品，也能查看所有待製作訂單合併後的飲品數量。
- 商家待製作明細 [完成] (8/29) — 使用者實機操作發現：[MerchantDashboardScreen.jsx](mobile/src/screens/MerchantDashboardScreen.jsx) 原本只顯示「已請款 N 筆」這種統計數字，跟一個「標記可取餐（N 筆）」整批按鈕，完全沒有任何地方列出這些訂單實際的飲料品項、數量、客製化內容，商家無從得知要做什麼。查證後端 API（`listMerchantStoreOrders` → `getPostgresOrderDetail`）其實早就有回傳完整品項與客製化資料，手機端同步時也已經存進 `appState.orders[].items`，純粹是這個畫面從沒有把它印出來；補上「待製作明細」區塊，列出每筆待製作訂單的顧客與品項（例如「午後百香果茶 x1（微糖、正常冰、椰果）」），放在「標記可取餐」按鈕之前，讓商家點下去之前能先看到要做什麼。純手機端 UI 改動，未動後端。已用開發控制台真實登入測試商家帳號、對真實 PostgreSQL 資料庫裡一筆已請款訂單驗證畫面正確顯示品項與客製化內容，`npm test` 95/95 全過
  > 商家原本完全看不到「這些已經付款成功的訂單裡到底要做哪些飲料」，只看得到一句「已請款 N 筆」的數字，現在補上實際品項清單，讓商家知道要準備什麼。

## UI/UX 打磨 [進行中]
> 畫面好不好用、好不好懂、排版有沒有問題，跟功能邏輯對不對是分開的兩件事；這裡專門追蹤這類發現與修正，不歸在特定功能模組底下。
- 商家菜單管理：客製化選項輸入框排版跑版 [完成] (8/30) — [MerchantMenuManagementScreen.jsx](mobile/src/screens/MerchantMenuManagementScreen.jsx) 尺寸／甜度／冰量／加料選項的「名稱」「加價」輸入框缺少排版設定（`minWidth: 0`），手機寬度下輸入框無法正確縮小，把「刪除」按鈕擠出畫面外。已修正，實測 375px 寬度下三個元件都完整顯示、不再跑版，`npm test` 95/95 全過
  > 商家新增或編輯飲品的客製化選項時，畫面排版會壞掉，「刪除」按鈕被擠到畫面外看不到。
- 商家菜單管理：分類欄位不清楚要填什麼 [完成] (8/30) — 「分類代碼」欄位原本標籤模糊、預設值是英文的 `tea`，商家不知道這格是做什麼用的，而且填的內容會直接顯示成顧客選飲料畫面上的分類頁籤文字。已把標籤改成清楚說明會顯示給顧客看、請填中文，預設值改成中文範例「茶類」，並新增「這家店目前已用過的分類」快速選取按鈕，避免商家重複輸入或打出不一致的分類名稱
  > 商家不知道「分類代碼」這欄要填什麼，填錯或用英文，顧客端就會看到奇怪的英文分類名稱。
- 選項按鈕選中時文字跑位 [完成] (10/3) — 使用者在平板實機錄影回報：點客製化選項（甜度、冰塊、尺寸、加料）時，同一排的按鈕文字會跑位。原因是共用元件 `ChoiceChip` 選中時把文字從一般（400）換成粗體（700），粗體同字級下比較寬，把同一排自動換行的按鈕擠開。已改成選中與未選中同字重，只靠外框、底色與文字顏色區分選中（`mobile/src/components/ChoiceChip.jsx`），所有用到 `ChoiceChip` 的畫面（客製化、分類、分頁、距離篩選）一併修好。`npm test` 238/238 全過；網頁預覽實際點選「微糖」，前後整排按鈕位置不變。**手機真機尚未確認**。
  > 在選項按鈕群組裡點選時，其他按鈕的位置與文字不應該移動。
- 全面性 UI/UX 檢視 [待處理]
  > 目前這裡列出的問題，都是使用者實際操作時偶然發現的，還沒有系統性走過每個畫面，逐一確認排版、文案、操作流程是否清楚合理。
- 品牌改版：揪飲 JOIN [進行中] (10/6) — 已套用：App 名稱改「揪飲 JOIN」（`app.config.js`、登入頁、後台網頁標題）；配色改品牌藍 `#2563EB`／深藍 `#172554`／柔和藍 `#EAF4FF`，淺色與深色模式都換（只動 `tokens.js`，其他畫面沒有寫死舊色碼）；登入頁飲料線稿換成品牌藍（淺色）與淺藍（深色）。`npm test` 257/257 通過（含 11 項配色對比度測試）；網頁模擬看過淺色與深色的登入頁和首頁。桌面圖示換成設計方提供的圖示版（10/7，原稿 `docs/brand/join-icon-designer.jpg`，處理成滿版藍底並留安全邊的 `icon.png`）。**暫不套用**（使用者 10/6 決定）：登入頁的主 logo，素材 `docs/brand/join-logo-sticker.png` 備用。**待做**：App 名稱與桌面圖示是原生設定，要打包 APK 才會變，尚未在 Android 實機確認；提案建議的圓體字型沒有採用（需新增 `expo-font`）；活力橘與奶茶米目前沒有在 App 內使用。
  > 把 App 換成「揪飲 JOIN」品牌：名稱、配色與桌面圖示先上線，登入頁主 logo 的素材已備好，等使用者決定後再套用。
- 視覺風格系統 [進行中]
  > 讓整個 App 的顏色、字級、圓角和狀態標籤長得一致，取代現在每個畫面各自寫死的顏色。規則與選定的風格記錄在 [ui-style-guide.md](docs/ui-style-guide.md)。
  - 換用紫青配色 [進行中] (9/24) — 使用者從配色網站挑了一組四色（深紫、灰藍、青、薄荷），比較過藍綠、暖粉彩、鼠尾草橙、紫青、藍共 9 組並排預覽後選定紫青，取代 9/20 的黑糖褐（「App 內不使用藍色」的規則一併作廢）；只改 [tokens.js](mobile/src/theme/tokens.js) 的設定值，所有已換新樣式的顧客畫面自動換色，六種狀態標籤重新配色，登入頁與商家端 6 個畫面也改成引用同一套設定（只換顏色，版面與按鈕形狀不動；商家首頁的藍色橫幅改成一般店名列），至此 19 個路由全部使用新配色。自動檢查 10 項全過（狀態標籤底色最小色差 15，門檻 8），並用網頁預覽看過登入、首頁、個人中心。**尚未做的**：Android 實機確認、按鈕樣式重做（使用者決定另外處理）、登入插圖與桌面圖示重新上色、清理共用元件已沒人用的舊樣式分支與 `MilkTeaContext`、商家「製作清單」與有資料的儀表板畫面沒有實際看過；青色「進行中」標籤是所有標籤裡最亮的一顆，需要實機確認會不會太搶眼。
    > 把整個 App 的主色從黑糖褐換成使用者挑的紫青配色，並確認文字對比與狀態標籤仍然清楚。
  - 深色模式 [進行中] (9/25) — 個人中心右上角一顆圓形太陽／月亮鈕，按下去切換淺色與深色，切換是漸變（新主題底色圖層淡入蓋住舊畫面、底下換主題、再淡出，約 0.4 秒）；第一次啟動跟隨手機系統，之後記住選擇。做法：`tokens.js` 加 `darkColors`／`darkTones`（自動檢查兩組都跑，11 項全過），新增 `ThemeContext.jsx`（`useTheme`／`useThemedStyles`），約 40 個畫面與元件的樣式用語法樹分析的腳本改成 `makeStyles(colors, tones)` 寫法（樣式內容沒變，另有靜態檢查確認沒有漏掉的變數、沒有在非元件裡呼叫 hook）；Google 地圖手機版與網頁版都套用調過色的夜間樣式；登入插圖改成透明底、依主題上色（順便完成「登入插圖重新上色」）。用網頁預覽看過登入、首頁、個人中心、即時地圖、商家首頁的深色與淺色，量過漸變的圖層透明度曲線。**尚未做的**：Android 實機確認、桌面圖示與啟動畫面（原生設定）、商家端沒有切換鈕、有資料的畫面（活動卡、訂單明細、付款、取餐憑證）深色沒有實際看過。
    > 讓 App 可以切換成深色外觀，夜間使用不刺眼，並且地圖也一起變暗。
  - 清理舊樣式與死程式 [完成] (9/25) — 全部 19 個路由都已使用新設定值後，刪掉舊的「奶茶樣式」機制（`milkTeaRoutes.js`、`MilkTeaContext.js`、`App.jsx`／`RootNavigator.jsx` 回報目前路由的狀態，以及 8 個共用元件裡沒人在用的舊樣式分支，元件內的寫死色碼隨之消失）；另用語法樹分析全站找死程式並清掉：沒用的引入 3 處、函式 1 個、`makeStyles` 沒用到的 `tones` 參數 22 處、12 個畫面沒用的 `memberAction` 參數、沒人讀的 `routeName`（`selectRole` 與 `authRouting`）、沒有任何地方引用的檔案 `TierLadder.jsx`、`mock/groupBuyActivities.js`、只剩內部使用卻被匯出的 3 個函式、沒有引用的 `clearPrototypeState`、`googleMapsEmbedUrl`。分析結果：手機端未使用的引入／變數／參數／匯出／孤立檔案／樣式鍵全部歸零；套件依賴沒有真的沒用的；後端與腳本沒有死檔案，只有 `scripts/pickup-individual-postgres-rollback-smoke.js` 沒有登記在 `package.json` 也沒被引用（手動執行的回滾測試，先留著，待決定）。全部檢查通過（`npm test` 171/171、Babel 全站 99 個檔案），網頁預覽已實際走過顧客四個分頁與商家儀表板（活動卡片），無主控台錯誤；Android 實機尚未驗證。
  - 首頁距離篩選改成橫向選項列 [完成] (9/24) — 原本是點開後整排展開的下拉，會把下面的活動推出畫面；改成「不限／500 公尺／1／2／3／5 公里」一排選項（沿用「我的訂單」分頁用的 `ChoiceChip`，選中＝白底加灰藍外框），一次點選、不會展開，超出螢幕寬度時可左右滑。用網頁預覽確認選中狀態會切換、可以橫向捲動；Android 實機手感尚未確認。
    > 讓顧客切換搜尋距離時，不必展開一大塊選單，一眼看到所有選項。
  - 風格方向與統一設定 [完成] (9/20) — 使用者比較深鈷藍、淺藍、霧藍、黑糖褐四組後選定「不用藍、黑糖褐」；數值放在 [tokens.js](mobile/src/theme/tokens.js) 與 [statusTones.js](mobile/src/theme/statusTones.js)，新增 10 項自動檢查（文字看不看得清楚、狀態顏色分不分得開、每個狀態都有對應顏色）
    > 把選定的顏色、字級、圓角，以及 33 種狀態標籤各自用哪種顏色，寫成畫面可以直接引用的統一設定，並且用自動檢查確保文字看得清楚。
  - 把畫面裡寫死的顏色換成統一設定 [進行中] (9/22) — 改成在各畫面換皮時一併換掉（不再另做一輪「外觀不變」的整批替換）；`mobile/src` 裡寫死的色碼從 565 處（32 個檔案）降到 258 處（18 個檔案），剩下的全部是還沒換皮的商家畫面與登入選角色畫面（唯一例外：即時地圖手機版的定位圖釘顏色，Android 原生圖釘只能指定色相，程式裡有註解說明不能直接引用設定值的原因）
    > 各畫面裡各自寫死的顏色，逐步改成引用統一設定，直到所有畫面都不再自己寫死色碼。
  - 共用元件換上新配色 [完成] (9/22) — 版面、底部導覽、狀態標籤、折扣卡、按鈕、同步提示已能依路由自動切換新樣式（由外殼統一決定，畫面不必手動傳旗標），沒換的畫面預設仍是舊樣式、不受影響（用修改前後的輸出逐字比對確認）；新增卡片、提示框、選項標籤、勾選列、數量加減、金額列、空狀態、大型珍珠盤、級距階梯等共用元件
    > 按鈕、頁面標題、狀態標籤、底部導覽這幾個到處共用的元件換上新配色。
  - 珍珠進度盤 [完成] (9/22) — 首頁與取餐憑證用的小型珍珠、團購詳情與進度頁的大型珍珠盤（含級距很大時一顆代表多杯的換算）都已完成，填幾顆的規則與換算規則都有自動測試
    > 用一排珍珠代表團購目前訂了幾杯，取代現在細細的進度條。
  - 顧客端畫面換上新風格 [完成] (9/22) — 顧客端全部 10 個畫面（首頁、即時地圖、店家菜單、店家的團購列表、團購詳情、團購進度、選飲料、購物車、付款預授權、我的訂單、個人中心）與取貨資訊都已換；用 `react-native-web` 把真正的元件畫成網頁，逐情境截圖檢查過（含空狀態、窄螢幕、資料缺漏），付款與我的訂單額外逐行核對過沒有改到金額或付款邏輯，`/security-review` 沒有發現漏洞（記錄在 [AI-security-review-log.md](docs/AI-security-review-log.md)），全部測試 174/174 全過；Android 實機尚未確認，商家畫面與登入選角色待處理
    > 顧客畫面先、商家畫面後，逐一換上新風格並確認排版。
  - 分頁切換滑動動畫與導覽架構改用 react-navigation [完成] (9/23) — 9/22 版本（純 React Native 內建動畫、沒加套件）切換分頁時仍會頓卡，因為每次切分頁都整個重新掛載畫面元件（含即時地圖的原生地圖）；使用者確認後改用業界標準的 `@react-navigation/native` + `bottom-tabs` + `native-stack` + `react-native-screens`（讓分頁畫面保持掛載、只是原生層隱藏／顯示，不再重新掛載）＋ `react-native-gesture-handler`（這兩個套件內部需要），取代原本手刻的 `stack` 陣列導覽器（`AppNavigator.js`／`ScreenTransition.jsx`／`slideTransition.js`，均已刪除）。全站 19 個路由、約 54 個導覽呼叫點逐一遷移，業務邏輯（`actions`、8 個輔助函式、3 個主要 effect）用程式逐字比對新舊檔案確認零差異。順帶採用使用者確認的三項架構決定：(1) 切換分頁時保留各分頁自己的瀏覽紀錄（不重置），才是真正解決頓卡根因（畫面不重新掛載）的必要前提；(2) 一併修掉兩個既有的 Android 實體返回鍵 bug——「我的訂單」與「商家後台」的訂單明細原本是畫面內部的 local state 切換，返回鍵完全不知道要先關明細，會直接跳出畫面，改成用 react-navigation 的「同一路由 push 第二次＋帶 orderId 參數」讓明細變成真正可被返回鍵彈出的獨立畫面；(3) 即時地圖分頁失去焦點時暫停 GPS 定位追蹤（`useFocusEffect`），畫面常駐後避免背景持續定位耗電。過程中額外發現並修正一個此次遷移本身造成的 bug：`selectRole`／`logout`／`goToRoleSelect` 原本呼叫 `navigationRef.reset()` 直接重置導覽狀態，但新架構的根導覽器是「登入前／顧客／商家」三選一互斥切換畫面組，`reset()` 目標路由不在當下掛載的畫面組裡一定失敗（`goToRoleSelect` 因為不會改變角色，沒有其他機制補救，等於會員頁「重新登入」按鈕點了沒反應）；改成用一個 `showingRoleSelect` 狀態旗標驅動同一組條件式渲染。驗證：`npm test` 170/170、Babel 解析全站 99 個檔案 0 失敗；用 `react-native-web` 本機預覽＋本機後端實際走過顧客與商家兩條路線（登入、四個分頁互相切換＋跨分頁導覽、加入團購→選飲料→購物車→預授權→訂單成立、點進訂單明細再返回確認彈回列表、商家建立活動的兩種入口皆可正確返回、登出、`showingRoleSelect` 修復後不再出現主控台錯誤）。**尚未做的**：Android 實機／模擬器操作確認（僅網頁預覽，無法驗證真正的實體返回鍵，只驗證了 react-navigation 內部的 stack pop 機制）；舊測試 `mockCapturePickup.test.mjs` 改讀取新檔案位置後已確認通過。過程中順手發現一個與此次遷移無關的既有問題（訂單明細品項列有巢狀 Pressable，`react-native-web` 會產生 `<button>` 巢狀 `<button>` 的 DOM 警告，不影響功能）——已另開背景任務追蹤，這次沒有動它。因為碰到 auth 相關的 session 邏輯與全部金流畫面的導覽呼叫點，已主動跑過一次 `/security-review`，沒有發現漏洞（記錄在 [AI-security-review-log.md](docs/AI-security-review-log.md) 2026-09-23 這筆，含 `goToRoleSelect` 那個 bug 的完整說明）。
    > 讓底部四個主要分頁之間的切換真正流暢不頓卡，改用業界標準的 react-navigation 讓分頁畫面常駐不重新掛載；同時修掉兩個既有的返回鍵 bug 並讓地圖分頁不在背景時繼續定位耗電。

## 非主要產品功能 [待處理]
> 不影響第一階段團購、下單、付款與取餐主流程，但可在核心功能穩定後補充使用體驗的次要功能。
- 討論區 [已移除]（2026-09-13）— 底部導覽入口與靜態佔位畫面（`CustomerPlaceholderScreen`）已整個刪除，不再列入規劃
  > 原本設想讓顧客針對團購活動留言、揪團討論或向店家提問；使用者決定拿掉，之後若要做屬於全新規劃。
- 商家營運統計 [完成] (9/26) — 新增 `GET /api/merchant/stores/:storeId/statistics` 與商家首頁「營運統計」畫面（累計實收、成交訂單、折扣讓利、成團率、熱賣飲品前三名）；單元測試後端 5 項、手機端 4 項，真實 PostgreSQL smoke（`npm run merchant-statistics-postgres:smoke`）用三家暫時店家驗證計入範圍與「一家店看不到另一家」，並做過八種「故意弄壞條件」反向驗證，`npm test` 199/199；真實 HTTP 驗證無 token 401、顧客／管理員／別家商家／不存在或亂填的店家編號都是 403、只有自己的店 200，並用另一套算法從原始資料重算 store-001 的數字，逐項一致；網頁預覽用商家身分實際看過有數字與錯誤重試畫面；另做過一輪獨立審查，留下的低風險建議已處理。**尚未做的**：Android 實機確認；日期區間與趨勢圖；深色模式沒有另外截圖檢查。
  > 讓店家在 App 裡看到自己店的營運成績：一共收了多少錢、有多少筆成交訂單、打折讓出去多少、團購成功的比例、哪些飲品最好賣。只算已請款、未取消的訂單，全額退款不算、部分退款會扣掉；每家店只看得到自己的數字。
  - 商家端補上近期趨勢長條圖 [完成] (9/28) — `GET /api/merchant/stores/:storeId/statistics` 現在同時回傳既有的 `merchantStatisticsRepository.getStoreWeeklyTrend()`（原本只有後台單店頁面在用），手機「營運統計」畫面新增「近期訂單趨勢」區塊，視窗長度與補零細節見下一筆。Mobile 專案沒有裝圖表／SVG 套件（新增原生依賴要重新打包 APK），改用純 `View` 疊出的長條圖（`WeeklyTrendChart`，高度比例＝`orderCount / maxOrderCount`），不是折線圖。`mobile/tests/merchantStatistics.test.mjs` 補上 `weeklyTrend` 驗證案例；已切換本機開發身份模式、以商家身分（北區茶作館）在網頁預覽實際看過長條圖渲染正確（14/1/2/23/5/13，跟後台看到的同一組數字對得上）。`npm test` 208/208 全過，事後跑過 `/security-review`（確認 `getStoreWeeklyTrend` 透過商家路由曝露時，店家範圍限制跟既有查詢一致），沒有發現問題，記錄在 `docs/AI-security-review-log.md` 2026-09-28 追加的那筆。
    > 商家不用每次都問平台或等管理員幫忙查，自己就能看到自己店的成長曲線。
  - 商家端趨勢圖表視窗延長、補零與正確性修正 [完成] (9/28) — 上面那筆的後續：畫面截圖顯示視窗太短、缺訂單的週直接從圖表消失，改成 `WEEKLY_TREND_WEEKS = 13`（近 3 個月，獨立於 `adminStatisticsRepository.js` 自己的 8 週常數，兩者刻意不共用）；`getStoreWeeklyTrendPostgres` 改寫成 `generate_series` 產生 `week_series` 再 `LEFT JOIN` 真實訂單，缺訂單的週補 0 而不是整週從陣列裡消失。手機端 13 根長條的日期標籤會互相重疊，加 `MAX_VISIBLE_WEEK_LABELS`／`labelStride` 只隔幾根顯示一次日期（每根長條與數值本身都還在，只是不是每根都有日期）。事後 `/code-review`（9/29）另外抓到並修掉兩個問題：(1) WHERE 邊界原本寫成 `date_trunc('week', now() AT TIME ZONE 'Asia/Taipei') - make_interval(...)`，拿一個被轉換成無時區 timestamp 的值去跟 `submitted_at`（timestamptz）比較，Postgres 會用連線自己的時區（Azure 上是 UTC）把它轉回去，等於整個邊界跟著跑掉 8 小時、悄悄漏掉最舊那週清晨的訂單——改成跟 `adminStatisticsRepository.js` 同樣的安全寫法（`now() - make_interval(...)`，兩邊都是 timestamptz，不經過無時區轉換）。(2) 查詢改成永遠補零回傳整整 13 列之後，`[]`（空陣列）已經不可能再代表「這家店真的還沒有訂單」，只可能代表 `.catch(() => [])` 悄悄吞掉了查詢失敗；改成 `.catch(() => null)`，手機端 `normalizeMerchantStatistics` 新增 `weeklyTrendUnavailable` 旗標，畫面上「查詢失敗」跟「真的還沒有訂單」現在顯示不同訊息，而且不會因為趨勢圖掛掉就連累其他已經算出來的數字整包顯示失敗。`npm test` 全過。
  - 商家端趨勢圖表改用真正的折線圖（加裝 react-native-svg） [完成] (10/1) — 上面兩筆的純 `View` 疊高度長條圖，0 值那幾週原本套最低高度避免柱子細到看不見，結果看起來像跟旁邊柱子不平行的雜訊線；先把 0 值柱子改成真正 0 高度（不畫）解決過一次，使用者仍覺得視覺上「怪」，之後同意裝圖表套件。裝了 `react-native-svg`（Expo 相容版本，見 `mobile/package.json`），`WeeklyTrendChart` 整個改寫成折線圖：跟 `backend/server.js` 的 `renderLineChart`（後台網頁版折線圖）同一套版面與計算方式（0-100 viewBox、`preserveAspectRatio="none"` 拉伸、`vector-effect="non-scaling-stroke"` 避免線被拉伸壓扁、資料點改用絕對定位的圓點而不是 SVG `<Circle>`，因為圓點半徑在非等比拉伸下會變成橢圓），手機與後台網頁現在呈現同一種圖表形狀。**這筆推翻了 9/28 那筆「Mobile 專案沒有裝圖表／SVG 套件」的敘述**：現在已經裝了，屬於新增原生依賴，要重新打包 APK 才會在已安裝的 App 上生效（可以跟已經因為推播通知欠的那次重包一起做，不用多重包一次）。已在瀏覽器預覽（react-native-web）登入商家測試帳號實際看過訂單數與營收兩張折線圖正確渲染，含 0 值週的資料點正確落在基準線上；`npm test` 238/238 全過。這個畫面本來就沒有既有的 RN 元件測試檔案，這次沒有另外引入新的測試框架。
  - 顧客回購／留存分析 [完成] (9/28) — 後台 `/admin/statistics` 新增兩個指標：(1) 總體顧客回購率（曾下過至少 1 筆有效訂單的顧客裡，下過 2 筆以上的佔比），卡片附帶「X / Y 位」明細；(2) 每週回頭客佔比趨勢（近 8 週折線圖，回頭客＝這週下單的顧客裡，更早之前就下過有效訂單的比例）。`adminStatisticsRepository.js` 新增 `getCustomerRetention()`，關鍵細節是「這位顧客是不是第一次」要看**全部歷史**（不限近 8 週）才能判斷，只有最後輸出限定在近 8 週——SQL 用兩層 CTE 確保「找第一筆訂單」這一步不受 8 週視窗影響。新增 fake-DB 單元測試 3 項；真實 Postgres smoke test 建立 3 個帶固定後綴的臨時顧客（新顧客／近期回頭客／舊回頭客，舊回頭客的第一筆訂單特意設在 20 週前，超出 8 週視窗），驗證他們的回購狀態都被正確判定，並且**實測過**刻意把「找第一筆訂單」也限定在視窗內會讓測試失敗（一開始這樣寫的測試因為跟資料庫裡既有顧客的行為混在一起而抓不到這個 bug，後來改成在建立測試資料前先查清楚那位既有顧客本來的回購狀態，讓判斷式改成精確相等而非寬鬆的「至少幾個」，才真的抓到）。`npm test` 208/208 全過，已用瀏覽器登入本機後台看過卡片與折線圖渲染正確；事後跑過 `/security-review`（本次重點確認回購率查詢沒有把個別顧客 ID／Email／姓名帶出資料庫查詢範圍，只有彙總數字），沒有發現問題，記錄在 `docs/AI-security-review-log.md` 2026-09-28 追加的那筆。
    > 通常團購／雙邊平台這種商業模式裡，顧客回購比新顧客獲取更影響長期健康，但目前完全沒有這類分析
  - 轉換漏斗分析 [待處理] — 目前完全沒做。追蹤顧客從「看到團購／加入」到「完成付款」到「實際取貨」，每一步流失多少人，找出卡關的環節（例如開了團卻沒付款、付了款卻沒去取貨）
  - 其他討論過但還沒排入的方向：商家健康度分群（穩定成長／新加入沒起量／一直失敗，分群後平台可以針對性介入）、地理熱區分析（哪些地區有顧客缺商家、或有商家缺顧客）、平台抽成／營收分析（目前這個專案沒有平台抽成的商業模式，若之後要往真實營運走才會需要）
    > 呼應「通常這種商業模式有什麼商業分析可以做」的討論，先記錄下來避免之後想不起來討論過什麼，還沒決定要先做哪一個。
- 個人中心 [進行中]
  > 讓顧客查看與管理自己的會員資料、歷史紀錄及帳號設定。
  - 會員資料唯讀顯示與訂單/取貨紀錄入口 [完成] (8/24) — Web 預覽以本機測試身份登入驗證
    > 顯示登入時後端已回傳的姓名（不顯示信箱或電話，2026-09-26 使用者決定拿掉）；「查看我的訂單」按鈕連到既有「我的訂單」畫面，付款與取貨紀錄不重複另建一套。
  - 真正登出 [完成] (8/24) — `navigation.logout()` 清掉 bearer token、Firebase session、本機快取的訂單／購物車／付款紀錄，`/security-review` 抓到「原本沒清本機快取」的中風險問題已修
    > 按下登出不只是換畫面，而是真的清掉登入憑證跟裝置上快取的個人資料，避免同一台裝置換下一個人登入時還看得到前一位的購物車或訂單。
  - 省錢統計（累計省下金額） [完成] (9/25) — 新增 `GET /api/customers/me/savings` 與個人中心「省錢統計」區塊；後端單元測試 3 項、手機端 3 項，真實 PostgreSQL smoke（`npm run customer-savings-postgres:smoke`）9 種訂單情境全過並做過「故意弄壞條件」反向驗證，`npm test` 177/177；用本機後端＋網頁預覽實際看過有數字、空狀態、錯誤（關掉後端）與重試四種畫面，並以真實 HTTP 驗證無 token 401、商家 403、亂帶 query 參數無效；另跑過 5 角度獨立審查（每個發現由 3 位審查員嘗試推翻），留下 4 個低嚴重度問題已全數修正。**尚未做的**：Android 實機確認；深色模式只靠既有主題設定，這區塊沒有另外截圖看過。
    > 讓顧客在個人中心看到自己靠團購折扣一共省了多少錢、有幾筆訂單享有折扣。只計算實際請款成功、沒取消、沒逾期未取、團購沒被取消的訂單；全額退款不算，部分退款不扣。金額由後端算，手機不自己加總（訂單列表是分頁的，在手機上加會漏算）。
  - 會員資料編輯（暱稱／電話） [待處理]
  - 帳號關閉／去識別化流程 [待處理] — 規則已於 `docs/AI-database-candidates.md` 定義，API 與權限尚未實作

## 平台維運 [進行中]
> 讓整個系統長期穩定運作的後勤工作：資料庫搬家、資安檢查、套件更新——不是顧客/商家直接看得到的功能，但影響系統穩不穩、安不安全。
- 即時地圖按「篩選」閃退（原記錄為「特定裝置閃退：三星 Galaxy S24+」）[完成] (9/15) — 呼應 9/14 那筆記錄：原本以為是 S24+ 這支裝置特有的問題，9/15 使用者確認自己全部手機打開篩選面板也一樣閃退，範圍不是裝置差異，是所有裝置共同的邏輯 bug，之前查的方向錯了。追查後找到根因：9/13 commit `80f3dd0` 把 [ActivityFilterPanel.jsx](mobile/src/components/ActivityFilterPanel.jsx) 的搜尋半徑從按鈕改成 `@react-native-community/slider` 元件，這是原生模組，需要重新執行 EAS Build（原生打包）才能讓已安裝的 App 認得它；但 9/13 之後只推送了線上更新（EAS Update，只換 JS），從沒有重新打包過。結果是所有裝置上安裝的 App 本體都沒有這個原生元件的程式碼，一旦畫面試著渲染 `<Slider>`（也就是按下「篩選」打開面板那一刻）就會找不到原生元件而整個當掉——「按篩選才會閃退、所有手機都一樣」完全對得上這個機制。使用者在「改回按鈕（推薦，OTA 立刻修好）」與「保留滑桿、重新打包 APK（大家要重新安裝，且免費打包次數有限）」之間選了前者：已把 `ActivityFilterPanel.jsx` 逐行還原成 `80f3dd0` 之前的按鈕版 UI（與舊版位元組對位元組相同），並從 `mobile/package.json`／`package-lock.json` 移除 `@react-native-community/slider` 依賴（`npm install` 確認乾淨移除、無其他檔案引用）。`npm test` 138/138 全過，Expo Web 重新 bundle 無報錯。已推送並發布 EAS Update（commit `592d534`）。**尚未實機驗證**：需要使用者或組員重新打開 App（或強制停止＋重開抓到這次更新）確認按「篩選」不再閃退。
  > 反覆閃退代表 Android 系統偵測到同一個 App 連續當機好幾次，直接擋下不讓使用者再打開；不是普通的畫面顯示錯誤。
- 篩選面板底部被系統手勢列/返回鍵擋住 [完成] (9/15) — 使用者同一則回報裡一併提到的第二個問題。根因：RN 的 `Modal` 元件會另外開一個原生 overlay 顯示內容，不在 `App.jsx` 根層 `SafeAreaView` 的畫面樹裡，所以套用篩選面板（用 `Modal` 實作的 bottom sheet）拿不到那層安全區域 padding，底部（含「套用篩選條件」按鈕）貼齊螢幕最下緣，被 Android 手勢列或返回鍵列蓋住。修法是在 `ActivityFilterPanel.jsx` 內用既有已隨機安裝的 `react-native-safe-area-context`（`useSafeAreaInsets`，非新增原生依賴，App 啟動時的 SafeAreaProvider 早就在用同一個套件）幫 sheet 補上 `insets.bottom`。`npm test` 138/138 全過，Web 預覽開啟面板無報錯、版面正常（web 沒有手勢列，`insets.bottom` 為 0，等同沒有此改動前的樣子，屬預期）。**尚未實機驗證**：底部安全區域插入量只有真機（尤其是使用手勢導覽的 Android 機型）才量得出來，需要使用者實機確認按鈕不再被手勢列擋住。
- PostgreSQL 遷移 [進行中]
  > 開發階段先用輕量的 SQLite 資料庫，正式上線前要把所有資料搬到功能更完整、適合正式營運的 PostgreSQL 資料庫，這整個搬家工程就叫「遷移」。
  - API／資料存取切片搬遷 [完成]
    > 把顧客、商家平常在用的各種功能（登入、菜單、下單、改單、結算查詢等）背後的資料存取邏輯，逐一改成可以切換到 PostgreSQL 執行，一次搬一小塊，確保每搬一塊都測試過沒有壞掉。
    - Auth／公開菜單／活動／訂單讀取 [完成]
      > 登入驗證、菜單、活動、訂單查詢這些「讀資料」的功能，已確認可以在 PostgreSQL 上正常運作。
    - 商家建團／菜單／顧客首次建單 [完成] (7/31) — 跨連線 HTTP proof 驗證
      > 商家建立團購活動、編輯菜單、顧客第一次下單這些「寫入新資料」的功能，已確認可以在 PostgreSQL 上正常運作。
    - Capture／結算 [完成] — postgres smoke test 驗證，已接 server route
      > 正式請款跟訂單結算這兩個跟錢直接相關的功能，已確認可以在 PostgreSQL 上正常運作。
    - 改單／退款／取貨憑證（004 migration） [完成] (8/12) — 對應 repository 與 smoke test 驗證，過程中修正 3 個真實 bug
      > 修改訂單、退款、取貨憑證這幾個功能對應的資料表搬遷工程（第 004 號搬遷腳本）。
    - 店家清單／地圖資料查詢 [完成] (8/20) — 新增 `storeDirectoryReadRepository`（`STORE_DIRECTORY_READ_RUNTIME`），`/api/stores` 改為透過此 repository；smoke test 4 案例、既有測試 59/59 全過，實際啟動 backend 確認 SQLite 路徑回應內容與改動前一致
      > 提供地圖跟店家列表用的店家資料查詢功能，現在已經可以透過設定切換到 PostgreSQL。
    - 訂單送出前編輯 [完成] (8/20) — 併入既有 `customerOrderWriteRepository`（`updateOrder`），重用建單流程既有的計價／折扣驗證邏輯；修正了一處會讓這條路由在 PostgreSQL 模式下持續回傳 503 的既有防呆判斷（`isSqliteOrderDependentRoute`）；smoke test 8 案例、既有測試 59/59 全過，實際啟動 backend 確認無異常
      > 顧客送出訂單前修改購物車內容的功能，現在已經可以透過設定切換到 PostgreSQL。
  - 背景與共用機制 [完成]
    > 不是使用者直接操作的畫面功能，而是系統自己在背後定期執行的檢查、對帳、防止衝突的機制，這些也要能在 PostgreSQL 上正常運作。
    - LINE Pay 對帳與重試背景排程 [完成] (8/20) — `reliabilityService.js` 整組，含對帳排程、人工重新請款（確認回跳＋發起請求）、監控告警查詢
      > 定期檢查有沒有付款卡在中間需要重新對帳、重試的背景程式，以及對應的人工重新請款、監控告警查詢功能，現在都已經可以透過設定切換到 PostgreSQL。
      - 人工重新請款：確認回跳流程 [完成] (8/20) — 新增 `manualLinePayRepaymentRepository`（`MANUAL_LINE_PAY_REPAYMENT_RUNTIME`），重用既有 `customerOrderReadRepository`／`paymentAuthorizationCancelRepository` 的鎖與查詢邏輯；LINE Pay 確認回跳（`GET /api/payments/line-pay/confirm`）裡的人工重新請款分支已完整支援 PostgreSQL
        > 顧客點擊 LINE Pay 付款連結、完成付款後導回 App 這段流程裡，如果剛好是走「人工重新請款」（自動扣款失敗後由顧客手動重試）的情況，現在可以正確用 PostgreSQL 處理。
      - 人工重新請款：發起請求流程 [完成] (8/20) — `POST /api/payments/line-pay/repay`；原本 3 處未接上 repository 的直接呼叫（已請款和解、建立新預授權、排入對帳背景工作）改重用既有 `paymentCaptureRepository`／`paymentAuthorizationRequestRepository`／新的 `paymentReliabilityJobRepository`，不需要新寫 SQL；路由防呆改成有條件放行（5 個相關 repository 都切到 postgres 才放行，任一沒切齊維持原本擋停）
        > 顧客主動點擊「重新付款」按鈕、發起這次重新請款的功能，現在已經可以透過設定切換到 PostgreSQL，不會出現「切了一半、資料寫錯資料庫」的狀況。
      - LINE Pay 對帳排程本身 [完成] (8/20) — 新增 `paymentReliabilityJobRepository`（`PAYMENT_RELIABILITY_JOB_RUNTIME`），重用「團購結算」背景排程（`groupBuySettlementRepository`）本來就寫成通用邏輯、沒有寫死工作類型的 job-queue 函式，不需要新寫佇列 SQL；背景排程啟動條件改為視相依 repository 是否齊全動態決定，不再是「訂單走 postgres 就強制關閉」
        > 系統定期檢查「付款卡在中間、需要跟 LINE Pay 對一次帳」的背景程式，現在可以用 PostgreSQL 執行，不會因為訂單切到 PostgreSQL 就被自動關閉。
      - 監控告警查詢 [完成] (8/20) — `GET /api/admin/payment-reliability/alerts` 改走 `paymentReliabilityJobRepository.listAlerts`；smoke test 9 案例（涵蓋 job 佇列 4 個操作＋列表查詢 2 個）、既有測試 59/59 全過，實際啟動 backend 確認路由與排程都正常運作
        > 給營運人員看「有哪些付款背景工作卡住需要注意」的查詢功能，現在已經可以透過設定切換到 PostgreSQL。
    - ECPay 核心付款流程 [完成] (8/20) — 新增 `ecpayAuthorizationRepository`（`ECPAY_AUTHORIZATION_RUNTIME`），涵蓋發起請款、checkout 轉址頁、webhook 確認回跳；請款/作廢直接重用既有 `paymentCaptureRepository`／`paymentAuthorizationCancelRepository`（同一組 `payment_authorizations`/`payment_captures` 資料表，不需另開一組）；webhook 確認回跳重用既有 `paymentAuthorizationConfirmRepository` 的核心邏輯（已驗證該邏輯本來就是依 provider 參數判斷，非 LINE Pay 專屬）；過程中發現並修正一個既有的 LINE Pay Postgres 缺陷（`getLatestAuthorizationForOrder` 誤加了只認 LINE Pay 的 provider 篩選條件，跟 SQLite 版本行為不一致）；新增結算／商家取消流程裡「三個相依 repository 須同時切齊才信任 PostgreSQL 查詢結果」的執行期防呆（避免 ECPay 授權紀錄還留在 SQLite、卻被拿去查 PostgreSQL 而悄悄查無資料）；smoke test 9 案例＋既有 `ecpay:smoke`（含請款/webhook/結算請款/結算作廢/退款/重複請求擋停）、既有測試 59/59 全過，實際啟動 backend 確認正常，並用刻意設錯環境變數的方式驗證新增的防呆判斷真的會擋停
      > 用信用卡（ECPay）付款的請款、取消授權、收款結果通知（webhook）這三個功能，現在已經可以透過設定切換到 PostgreSQL；退款功能之前就已經支援。
    - 跨執行個體併發鎖定的 PostgreSQL 驗收 [完成] (8/20) — 本機改用原生安裝的 PostgreSQL 16 Windows 服務（環境沒有 Docker），連線設定沿用既有文件記錄的本機開發帳密；先重跑既有 7 個 postgres proof/http smoke test（含 `payment-capture-postgres`、`group-buy-settlement-postgres` 等）全數通過，確認先前結論在這台實際服務上依然成立；新增 `npm run postgres-reliability:multiprocess`（`scripts/postgres-reliability-multiprocess-smoke.js`），是既有 SQLite 版 `payment-reliability:multiprocess` 的 PostgreSQL 對應版本——用兩個真正獨立的 OS 程序（不是同程序開兩條連線）搶同一筆對帳工作、搶同一把 `order:{id}:payment-lifecycle` lock（LINE Pay 請款/取消/人工重新請款與 ECPay 共用的鎖），驗證搶佔互斥、租約到期接手、release 擁有權檢查；跑兩次確認結果穩定，測試自動清理，執行前後資料庫內容一致；詳細記錄見 `database/README.md`
      > 確認系統在「兩個程式同時想搶同一份工作」時，有正確的排隊機制，不會兩邊都搶到、也不會兩邊都沒搶到，這在牽涉金錢的系統裡是必要的保護機制。
  - 收尾與部署 [進行中]
    > 資料搬遷工程本身做完之後，還要準備的收尾工作：統一執行工具、確認沒有漏掉的地方、真正切換到正式環境上線。
    - 統一資料庫搬遷執行工具 [完成] (8/12) — 對應 `database/migrate.js`
      > 一個統一的工具程式，負責照順序執行資料庫搬家用的每一份腳本，避免手動一個一個跑、跑錯順序。
    - 剩餘 SQLite-only 範圍盤點 [完成] (8/19) — 逐一核對 `backend/db.js` 所有對外被呼叫的 64 個函式，與既有 17 個 repository 切片的對應關係，確認精確缺口（結果見下方 5 項）
      > 用程式碼追蹤的方式，把資料庫相關程式碼裡「已經能同時支援 SQLite 跟 PostgreSQL」跟「還只能用 SQLite」的部分完整分開列出來，確保沒有漏掉的死角，不用再邊做邊發現新的缺口。
    - PostgreSQL 切換 [完成] (8/20) — 把 backend 全部 21 個 `*_RUNTIME` 開關一次設為 `postgres`（寫入 `backend/.env`，透過既有 `backend/auth.js` 的 `loadLocalEnv` 自動載入，不需額外設定），**這是永久預設值、不是一次性測試後就切回去**；切換前修正 3 個先前已知的既有缺口（改單替換舊授權未接 repository、主要請款流程缺少建立失敗檢查、管理員舊版取消團購工具未連動訂單/付款），過程中另外發現並修正一類全新問題：`authorization` 是 PostgreSQL 保留字，3 支既有查詢把它當裸 SQL 別名用，先前只被假資料庫測試驗證過、從未真的被 PostgreSQL 解析執行過，這次對真實服務啟動時才现形；另外補套用一直沒被真正套用到本機資料庫的 `005` migration。發現 `backend/.env` 是全域生效（不只 backend 伺服器，任何間接用到登入相關程式碼的腳本都會載入），永久切換前先修正 `scripts/merchant-activity-cancel-service-smoke.js` 這支唯一沒有明確隔離 runtime 的獨立測試腳本（其餘 10 支同類型腳本本來就已經用 `env: {}` 隔離），避免之後任何獨立測試腳本悄悄查到錯的資料庫。完整寫入流程（建團、建單、LINE Pay 請款、商家菜單、改單、管理員/商家取消）與既有 `*-postgres-http-smoke` 系列、全部 11 支曾經受影響的 repository smoke test，皆已在永久切換後的狀態下對真實 PostgreSQL 16 重新驗證通過，`npm test` 59/59；一次待釐清的觀察（`pg` deprecation warning，未能穩定重現）記錄於 `docs/AI-security-review-log.md`；**後續補充 (8/20)**：又發現同一類問題的第二個受害腳本 `scripts/order-api-smoke.js`（用子行程啟動自己的 backend，只明確指定 2 個 runtime 開關為 sqlite，其餘沿用 `backend/.env` 悄悄補上的 postgres 值，兩邊混用觸發啟動期一致性檢查噴錯），已比照修正並全部 21 個開關明確列出；修好後發現這支腳本另外還有一個無關的既有問題（`database/drink-group-buy-dev.sqlite` 本機檔案資料過期，查不到 `store-001`），屬於本機檔案本身過期，不在這次範圍內處理，詳見 `database/README.md`
      > 把後端所有功能一次全部改成用 PostgreSQL 運作，當作正式上線後的實際運作方式，而不是每個功能分開個別測試。
    - 本機 SQLite 測試檔案資料過期 [完成] (8/21) — `database/drink-group-buy-dev.sqlite` 已用 `db:init` + `db:seed` 重建（重建前先備份至 `database/backups/`）；重建後 `integrity_check=ok`、`foreign_key_check` 無違規、`pickup_closing_time` 新欄位存在、`store-001` 資料正確（2 個菜單品項）；`order-api-smoke.js` 與其餘 6 支共用這個檔案的腳本（`ecpay-smoke`、`pickup-credential-smoke`、`pickup-expiration-smoke`、`settlement-smoke`、`refund-request-smoke`、`merchant-activity-cancel-service-smoke`）與 `npm test`（63/63）全數重新驗證通過
      > 部分還在用 SQLite 的獨立測試腳本，依賴這個本機檔案裡的資料，資料過期會讓這些測試失敗。
    - `GET /api/orders/:id/pickup-credential` 自 8/20 切換後其實一直打不通 [完成] (8/25) — 真機測試「店家標記可取餐後，顧客拿不到取貨碼」才發現：這支顧客端拿取貨碼用的路由，從 8/20 全面切到 PostgreSQL 那天起，就一直被啟動期一致性檢查擋下回傳 503（`customer_order_runtime_mismatch`），因為擋門函式 `isSettlementRouteReadyForPostgres` 檢查的是 `/api/pickup-credentials/`（複數、無 `/orders/` 前綴，從來沒有路由真的用這個網址），沒對到真正的路由 `/api/orders/:id/pickup-credential`；另外這支路由本身也還在直接呼叫底層 SQLite-only 的 `getOrderDetail`，沒有像其他路由一樣改用 runtime-aware 的 `customerOrderReadRepository.getOrderDetail`，就算擋門放行了也會因為訂單資料實際存在 PostgreSQL、查 SQLite 查不到而回錯誤。兩處一起修正；Mobile 端 `syncOrderFromBackend` 原本把這支呼叫的任何失敗都靜默吞掉（`catch { pickupCredential = undefined }`），沒有任何錯誤訊息，這是為什麼店家標記可取餐後，顧客端「看起來像沒生成」但其實資料庫早就有紀錄、只是 API 拿不到。修好後用真實 HTTP 請求驗證：訂單本人可正確拿到取貨碼（200 + 真實 `pickupCode`），换成別的顧客帳號正確被擋（403 `Order access denied`，確認沒有因為這次修改而放寬權限檢查）；`npm test` 77/77 全過
      > 商家在畫面上按「可取餐」之後，系統其實已經正常產生取貨碼存進資料庫，但顧客那支專門拿取貨碼的 API 一直被一個內部的「資料庫還沒切換完成」保護機制誤擋，回傳的錯誤又被 App 端悄悄吞掉不顯示，導致顧客看起來像「一直沒生成」，其實是拿不到已經生成好的碼。
    - Production 正式部署（備份、staging、rollback） [進行中] (8/20) — 已與使用者確認關鍵決策並寫入 `docs/AI-postgresql-migration-plan.md`（「2026-08-20 正式環境部署與真實資料起始方案」段落）：正式環境採自架伺服器（非代管服務）；備份策略、staging 定位、rollback 計畫（含「累積真實資料後開關不能再當 rollback 用」的風險說明）均已規劃並記錄；仍待處理：實際租用/設定伺服器、備份 cron job 落地、正式商家帳號連結方案（見下方子項）——這些需要真的申請伺服器與正式憑證才能繼續，非程式碼變更
      > 確保正式環境的資料庫在出問題時（例如硬碟壞掉、程式有 bug）不會整個系統的資料都不見，需要先規劃好的備份、測試環境跟復原方案。
    - Azure 課堂展示環境 [進行中] (9/11) — 已確認採 Azure App Service（Node.js Backend）＋ Azure Database for PostgreSQL Flexible Server，讓安裝 APK 的組員能從不同網路連線；這是非正式營運的教學展示環境，不取代上方 production 正式部署決策。Azure 資源已建立（資源群組、PostgreSQL、App Service）、資料庫 migration 已套用、環境變數已設定、PostgreSQL 防火牆已開放給 App Service、Backend 已重新部署上線（含帳號角色切換、登入失敗鎖定）——`/health` 與需要資料庫的 API（店家、團購活動、帳號角色）皆已驗證回應正常。Android APK 已重新打包（Debug Key 簽署，僅供內部測試；發現舊版沒有正確接上 EAS Update 已修正並重新產生原生專案），Firebase／Google Cloud 的 Android OAuth 用戶端 SHA-1 已直接用工具驗證跟新版 APK 簽章一致，且真機上已確認「全新帳號自動註冊」乾淨成功一次（真實姓名顯示＋資料庫帳號 ID 格式雙重驗證，不是誤判）。應使用者要求，展示環境已改成跟正式版行為一致：截止結算、付款對帳、取貨逾期三個背景排程都已開啟，LINE Pay sandbox 憑證與回呼網址也已補上（`LINE_PAY_ENV` 仍是 sandbox，沒有開真實金流），詳見 `docs/AI-security-review-log.md` 2026-09-11 第四次追加。**尚未完成**：還沒有實際走過一次「開團→下單→付款→截止結算」完整流程驗證這些排程真的照預期運作；還沒有做兩個帳號、兩種網路的跨網路端對端驗證（目前只驗證過一支手機、一個帳號）；部署過程中 PostgreSQL 密碼／Firebase Service Account Key／Session Secret 曾經在操作畫面上出現過，正式交付前應輪替，目前使用者已知悉、決定暫緩處理。詳見 `docs/azure-classroom-deployment.md`「目前狀態」
      > 把後端與多人共用資料庫放到 Azure，提供公開的 HTTPS 網址，讓不同地點的組員使用同一套資料；免費層可能休眠，因此不承諾全天候背景排程。
      - 展示用假資料產生器 [進行中] (9/25，9/30 擴充) — 新增 `scripts/seed-demo-data.js`（`npm run demo-data`）與產生邏輯 `scripts/helpers/demoDataBuilder.js`；單元測試 13 項（金額與正式結算逐筆比對、資料表關聯、狀態一致性、日期合理性，並做過三種「故意弄壞」反向驗證），`npm test` 190/190；已在本機 PostgreSQL 實際寫入約 30 場團購、215 筆訂單並用真實 API 讀回（個人中心省錢統計、訂單歷史與明細、取貨憑證、退款、活動列表、後台統計數字都正常），也測過清除後殘留 0 列且不影響原有資料，各種安全保護（不加 `--apply` 不寫入、遠端需 `--allow-remote`、已有示範資料拒絕重複寫入）逐一驗證。**9/30 擴充**：(1) 下單時間改成集中在中午 12 點、下午 6 點前後（新函式 `pickSubmittedAt`），讓後台「顧客下單活躍時段」圖表有明顯雙峰，不是均勻散佈 24 小時；(2) 新函式 `assignStores` 保證每家店都拿到公平的活動數下限（`Math.floor(activityCount / storeCount)`），再疊加既有的人氣權重分配剩餘場次，避免冷門店家因為單純加權隨機被分到太少場次、週趨勢圖表稀疏到看不出東西；新增 2 項單元測試驗證這兩個效果，`npm test` 237/237。已實際對 Azure 課堂展示環境與本機都清空重跑（`--activities 540 --customers 48`，9 家店每家保底 60 場，約每隔一天 2 團的密度），兩邊資料庫都驗證過店家活動數與訂單數對得上預期。過程中發現本機「午後水果茶 雙十店」`business_status` 是 `temporarily_closed`（Azure 上是 `open`），這不是產生器的 bug——腳本正確地把它排除在外；已改回 `open` 並重新產生一次讓本機與 Azure 一致。**尚未做的**：「我的訂單」在顧客只有歷史訂單時看不到歷史分頁的既有問題尚未處理；Expo 推播的 Ticket-level 錯誤（失效 token）沒有清除機制，跟這個產生器無關，屬於另一個功能的已知缺口。
        > 為統計頁與個人中心的「省錢統計」準備可展示的歷史資料：假顧客、過去 60 天內已結束的團購與訂單，付款一律是假付款、資料 ID 都有固定前綴，可以整批移除。
      - 9 家店菜單補齊到至少 15 種品項 [完成] (9/30) — Azure 與本機的店家菜單原本只有 1～13 種（多數店家只有 1～2 種），用既有、已測過的管理員批次匯入機制（`merchantMenuImportRepository.importMenuItems`，非新寫程式碼）逐店補上主題化新品項（依店名風格設計，例如「一中黑糖研究所」全黑糖系列、「森林紅茶」茶飲系店風），每個新品項都帶正確的甜度／冰量／尺寸／加料四組客製化選項（比照既有品項的選項與規則結構）。舊有品項依匯入機制既有行為下架（`is_available = false`），不會影響任何歷史訂單的參照完整性（此時兩個環境的團購活動都已經整批清空，沒有歷史訂單需要保留）。本機另外補上 Azure 上新增、本機缺少的 2 家店（森林紅茶 大雅店、橙山茶飲 崇德店，含對應商家帳號與門市資料），達到本機與 Azure 都是 9 家店、每家店 15～18 種菜單。
        > 讓每家店的菜單看起來夠豐富，熱賣飲品排行、菜單瀏覽這類展示畫面才有東西可以展示，不是只有 1～2 種飲料可選。
      - Mobile 線上更新策略 [完成] (9/12) — 已確認採 EAS Update 更新一般 JavaScript／畫面／圖片變更；首次安裝仍需 APK，原生套件、Android 權限、Expo SDK 等原生變更仍須重新打包。專案已連結 EAS（`@royor/drink-group-buy-mobile-prototype`）、`expo-updates` 套件已安裝、`app.config.js` 補上 `updates`／`runtimeVersion`、`eas.json` 已設定三個 build profile（`preview` 明確指定輸出 APK，供組員直接安裝，不透過 Google Play）。真機測試一度完全沒有跳出更新提示對話框——追查後找到真正原因：專案改用本機 `expo run:android`／`gradlew assembleRelease` 打包（因為 EAS 雲端打包當時沒有正確帶入 `mobile/.env` 的 Firebase API Key，出現 `auth/api-key-not-valid` 而改用本機打包，本機打包會自動讀 `.env` 所以沒有這個問題），但本機打包完全跳過 `eas build` 自動幫你把「這支 APK 屬於哪個頻道（channel）」寫進原生專案這個步驟，導致 APK 雖然 `expo.modules.updates.ENABLED=true`、更新網址也對，但不知道自己屬於 `preview` 頻道，`checkForUpdateAsync()` 永遠問不到對的地方、靜默找不到更新（用 Android SDK 的 `aapt dump xmltree` 直接核對過打包出來的 `AndroidManifest.xml` 才確認到這個層級，不是猜測）。已在 `app.config.js` 的 `updates` 下明確補上 `requestHeaders: { "expo-channel-name": "preview" }`，讓這個設定不再依賴用哪個工具打包；重新 `expo prebuild --clean` ＋ `gradlew assembleRelease` 產生新 APK 並實機重新安裝後，發布一次真正的線上更新（底部導覽列選中顏色從測試用的紅色改回原本的藍色），**真機成功跳出更新提示對話框、按下後正確套用、畫面顏色即時變更**，全流程端對端驗證通過。之後只要不重新用本機工具產生原生專案，改 JS／畫面都不用再重打 APK。
        > 讓組員安裝一次 App 後，多數畫面與程式邏輯修改可在線上更新，只有會改到 Android 原生程式的變更才重新下載 APK。
    - 真實資料搬遷方案 [完成] (8/20) — 確認開發資料庫裡的商家／門市／菜單資料其實是既有的開發示範資料（非另外接洽的真實商家），使用者確認直接沿用當正式起始資料；新增 `database/production-reference-seed-postgres.sql`（只含商家／門市／菜單，排除密碼登入的假帳號），已在真實 PostgreSQL 16 用一次性 throwaway schema 驗證套用結果正確（7 商家/7 門市/8 品項/96 客製化選項/32 條規則），不掛進 `database/migrate.js` 的自動 migration 鏈以避免正式環境被誤套用開發假帳號
      > 把現在開發資料庫裡可以沿用的資料（例如商家、門市、菜單），安全地變成正式環境一開始就有的起始資料的規劃與準備工作。
      - 正式商家帳號連結方案 [待處理]
        > 排除假帳號後，7 個真實商家要怎麼用自己的 Google 帳號登入、連到正確的門市，目前沒有後台介面可以做，只能手動下 SQL 指令，這部分還需要另外決定要不要做一個管理工具。
- 資安審查 [進行中]
  > 針對容易被攻擊或出錯的地方（付款、訂單、資料寫入等），檢查程式碼有沒有安全漏洞的審查工作。
  - 金流／驗證／資料寫入相關改動的安全複查 [完成] (累計至 8/20，共 11 次) — 8/11 付款/訂單修改/取貨憑證改動、8/13 作廢邏輯覆核（呼應 8/11 一筆待評估項）、8/15 業務時間串接（3 項中/低風險問題已修正）、8/15 付款狀態文案分離、8/15 取餐規則同意、8/15 告警驗證與結算快照、8/17 商家自助取消團購、8/20 PostgreSQL 遷移三個新切片、8/20 LINE Pay 對帳背景排程、8/20 ECPay 核心付款流程（1 個高風險問題已修正）、8/20 三個已知缺口修正＋PostgreSQL 全面切換（2 個中風險問題已修正）；全部沒有發現未解決的達門檻漏洞，詳細記錄見 docs/AI-security-review-log.md
    > 每次改到付款、驗證、資料寫入這類高風險的地方，完成後都要做一次安全複查，檢查有沒有資安漏洞——這是持續進行的例行檢查，不是做一次就結束。
- 依賴套件安全 [進行中]
  > 這個專案用到很多別人寫好的現成套件，這些套件本身也可能有已知的安全漏洞，需要定期檢查更新。
  - Mobile 框架升級（Expo SDK 51→54，啟用新版渲染架構） [完成] (8/19) — `expo-doctor` 18/18、既有測試 59/59、Android 模擬器實機操作驗證（地圖標記、公里篩選、商家取消團購雙擊防護皆正常）
    > 把開發這個手機 App 用的框架（Expo／React Native）從舊版升級到新版，同時提早打開下一版強制會用的「新版畫面渲染架構」（New Architecture），避免以後被迫一次跳更大步。
  - 已知漏洞修復（非強制） [進行中] — Root 從 7 項（6 中 1 高）修掉 1 項高風險（`brace-expansion`，無破壞性），剩餘 6 項中風險都要把 `firebase-admin`（登入驗證用套件）退回 10.3.0 舊版才能解，會是倒退不是修復，先不做；Mobile 從 46 項（1 低 11 中 33 高 1 重大）降到 20 項（9 中 11 高，無重大），剩餘需再升級框架才能繼續解
    > 用工具（`npm audit`）定期檢查目前用到的套件裡有哪些已知的安全漏洞，並視風險評估要不要修。
  - Expo SDK 57 升級 [暫緩] (8/19) — 套件相容性、`expo-doctor`、測試全過，但地圖套件（react-native-maps）在新版渲染架構下無法正常顯示地圖（Android 實機驗證發現地圖畫面完全空白），已退回 SDK 54；SDK 54 已符合 Google Play 2026/8/31 起的最低版本要求（Android 16 / API 36），非上架必要項目，暫不繼續往上升
    > 把開發這個手機 App 用的框架（Expo／React Native）從目前使用的 54 版升級到最新的 57 版。

## 系統分析書 [進行中]
> 一份完整說明整個系統設計、有哪些功能、每個功能怎麼運作的文件，通常給老師、審查人員或團隊自己參考用。
- 五大功能分類與描述性綱目 [完成]
  > 把整個系統的功能分成五大類，並列出每一類底下大概有哪些東西的文件大綱。
- 各小節使用個案描述與活動圖 [待處理]
  > 針對文件裡每個小節，補上具體的「使用情境描述」（例如：顧客怎麼下單）跟畫成流程圖的「活動圖」，目前還沒寫。

## 非正式與備援功能 [進行中]
> 不是給一般顧客/商家用的正式功能，是開發測試用的小工具，或是正式方案掛掉時的備用方案。
- 本機開發身份切換器（dev-only） [完成] — Backend 與 Mobile 都有 environment gate，且 README 明講「這不是正式產品角色選擇」
  > 開發時為了方便測試不同身份（顧客/商家）用的快速切換工具，只有開發環境能用，正式上線的版本裡不會出現，不算是真正的登入功能。管理員身份不在這個清單裡，改走下面的「管理員網頁後台」。
  - Mobile 端 [完成] — 本機測試身份下拉選單（8/22 起排除管理員身份，管理員不再有任何手機 App 入口）
  - Backend 端 [完成] — `AUTH_DEV_MODE` 閘門與 dev-session API
- 離線展示模式 [進行中] (10/1) — `EXPO_PUBLIC_DEMO_MODE=true` 時，登入頁（樣式與正式版一致）可一鍵以顧客或店家身份進入，所有後端呼叫改讀 `mobile/src/mock/demoContent.js`／`demoBackend.js` 的假資料（店家「青山手作茶 中科店」與其真實菜單），不寫入任何真實資料庫，也不寫入本機 prototype 儲存。已用網頁預覽實際操作過：顧客端（地圖、團購詳情、選飲料與客製化、購物車、送出訂單、修改訂單、個人中心省錢統計）與商家端（首頁、開團、菜單新增、分析頁含訂單／營收趨勢圖）；`npm test` 238/238 全過。**尚未實際點過、只有程式碼層級的本機模擬**：商家標記可取餐、取餐核銷、顧客取消訂單、商家取消團購。**限制**：假資料每次重新整理就重置；沒有涵蓋的畫面（例如退款、商家申請）仍會嘗試連後端；手機 App 原生建置內的展示模式尚未驗證；對外掃 QR code 連線是靠 Expo tunnel（ngrok），需要這台電腦保持開機。
  > 不連任何後端、全部用假資料的展示開關，讓專題展或試玩的人可以直接操作介面，不會動到真實資料。
- 管理員網頁後台 [完成] (8/22) — 伺服器直接輸出 HTML／表單（無另外的前端專案或建置流程），密碼登入寫在 `backend/.env` 的 `ADMIN_WEB_PASSWORDS`（逗號分隔，可設多組密碼給不同人用，登入後都對應到同一個管理員身份；與 `AUTH_DEV_MODE` 無關，正式環境也能用）；session 沿用既有 `createAuthToken`／`verifyAuthToken` 簽章機制存進 HttpOnly cookie，取消團購／核准退款／駁回退款都直接重用既有服務層函式，未新增或修改任何業務邏輯；每個會改資料的表單都帶一次性 CSRF token，已用真實 HTTP 請求驗證登入、未帶 CSRF token 會被拒絕（403）、以及對不存在的活動 ID 觸發取消會正確回傳錯誤訊息。原本手機 App 裡的 `AdminDashboardScreen`／`AdminRefundRequestsScreen` 已移除。事後跑過一次 `/code-review`（xhigh 強度，10 個角度）並全數修復其 15 個發現，包含 2 個真的邏輯缺口（取消團購時若有訂單付款作廢失敗，原本會誤顯示成功；退款審核列表頁原本漏掉資料庫執行模式一致性檢查）與其餘重複程式碼／效率問題；修復過程與驗證方式記錄於 `docs/AI-security-review-log.md` 2026-08-22 追加的那筆
  > 平台營運人員用來取消團購、審核退款的網頁工具，跟顧客/商家用的手機 App 完全分開；原本這兩件事是手機 App 裡工程師專用的開發畫面，現在搬成獨立網頁，比較符合「管理員不是正式 App 的一般角色」這個既有決議（`docs/open-questions.md`）。
  - 登入失敗鎖定 [完成] (9/11) — 連續猜錯密碼會被暫時鎖住，防止有人對著登入頁一直亂猜密碼。以來源 IP 記錄失敗次數（記憶體內，重啟後歸零，這個規模的課堂展示不需要額外資料庫表），連續 5 次錯誤後鎖定 15 分鐘，鎖定期間即使密碼正確也一律拒絕。已用真實 HTTP 請求驗證：第 1-4 次錯誤正常回應、第 5 次後鎖定生效、鎖定中送出正確密碼仍被拒絕；`npm test` 115/115 全過。**已知取捨**：用 `X-Forwarded-For` 判斷來源 IP，這個值需要有受信任的反向代理才可靠（Azure App Service 前端閘道符合，但如果之後在沒有代理的環境直接曝露伺服器就不可靠）；鎖定以 IP 為單位，同一個對外 IP（例如同一個校園 Wi-Fi）如果有人惡意亂猜，會連帶鎖到共用那個 IP 的其他人，是刻意接受的簡化設計。詳見 `docs/AI-security-review-log.md` 2026-09-11 第三次追加。
    > 有人對著管理員登入頁一直亂猜密碼時，系統會先暫時鎖住，不讓對方無限次嘗試。
  - 基本數據統計頁面 [完成] (9/17) — 新增 `/admin/statistics`，純讀取既有資料表，不新增欄位、不改任何資料。顯示：團購總場次、成功率（分母排除還在 draft/recruiting、尚未有結果的團購，只算 confirmed/ordering/ready_for_pickup/completed 對 failed/cancelled 的比例）、訂單總數、已請款訂單數、總營收與平均客單價（都只算 `payment_status = 'captured'` 的訂單）、依營收排序的熱門店家排行（最多 10 間）。新增 Postgres-only 的 `adminStatisticsRepository.js`（比照 `adminAccountRoleRepository.js` 的最小寫法，不做 SQLite 相容層）。已對真實本機 PostgreSQL 直接呼叫 repository 驗證數字正確（12 場團購、成功率 36%、營收與熱門店家排序都對得上手動核算），並在隔離環境重新渲染過一次頁面 HTML 確認樣板沒有壞掉；`npm test` 146/146 全過，`check:sql-safety` 通過。**尚未透過瀏覽器實際登入 `/admin` 點開這個頁面驗證畫面顯示**（本機當下有另一個工作階段的伺服器在跑，為避免衝突沒有搶著重啟）。
    > 讓管理員在網頁後台一眼看到幾個最基本的營運數字（團購成不成功、訂單賺了多少錢、哪家店最熱賣），不用自己連資料庫下 SQL 查。這是「基本統計」，不是使用者行為追蹤（例如誰點了哪個畫面），那個目前完全沒做，屬於更大範圍的數據分析工程。
  - 訂單/營收趨勢與顧客活躍時段分析 [完成] (9/28) — 在 `/admin/statistics` 加兩個區塊：(1) 近 8 週訂單與營收趨勢（依 `submitted_at` 分週，週一起算，換算成台灣時間，只算 `payment_status = 'captured'` 的訂單），含長條圖與表格（訂單數、營收、折扣金額、折扣佔原價比例）；(2) 顧客下單活躍時段（依小時統計，全部歷史訂單、不篩狀態，換算成台灣時間），24 小時長條圖。`adminStatisticsRepository.js` 新增 `getWeeklyTrend`／`getPeakHours` 兩個唯讀查詢，都用 `AT TIME ZONE 'Asia/Taipei'` 轉換（Azure 上的 Postgres 預設時區是 UTC，不轉換會讓「哪一週」「幾點」全部算錯）。新增 fake-DB 單元測試（4 項，驗證查詢條件與 24 小時補零邏輯）與 `admin-statistics-postgres:smoke`（這兩個查詢是對整張 `orders` 表彙總、沒有可以限定範圍的店家 ID，所以用「操作前後數字差異」而非「精確總數」驗證，並實測過刻意改壞 SQL 篩選條件會讓測試失敗）；`npm test` 172/172 全過，已用瀏覽器登入本機後台實際看過兩個圖表渲染正確。
    > 對應「後台數據分析要先做哪些」的規劃討論：趨勢圖（營收/訂單是成長還是衰退）、尖峰時段分析（顧客什麼時候在下單）、折扣成本 vs 營收（打折花了多少、佔營收多少比例）三項一次做完。
  - 後台版面改版：側邊欄導覽＋圓角卡片 [完成] (9/28) — 整個管理後台（全部 7 個頁面＋登入頁）從頂部橫向導覽列改成左側固定側邊欄（圖示＋文字，inline SVG、不額外載入圖示字型），卡片／按鈕／輸入框／通知列全部圓角化，帳號角色頁面的分類篩選從膠囊分頁改成底線分頁樣式；配色維持原本的黑白灰，沒有引入新的主色調。因為所有 7 個頁面內容函式本來就只輸出共用 CSS class（`.card`／`.stat-card`／`.badge`／`.tabs` 等），這次只改了共用外殼 `renderAdminPage` 的 CSS 與 HTML 骨架，完全沒有動到任何一個內容函式或路由邏輯；`backend/devConsole/public/styles.css`（本機測試控制台，共用同一組顏色變數但不是這次要求的範圍）沒有被動到。已用瀏覽器登入本機後台，逐一截圖確認全平台團購／數據統計／退款審核／帳號角色（含分頁切換）四個頁面渲染正確、側邊欄 active 狀態正確反白；也在 375px 寬模擬手機瀏覽器確認側邊欄會收合成僅剩圖示、頁面仍可操作。純視覺／版面調整，沒有改任何查詢、授權或資料寫入邏輯，所以沒有另外跑 `/security-review`；`npm test` 172/172 維持全過（純 hygiene check，這次改動理論上不影響任何測試）。
    > 使用者提供一張 YouTube Studio 數據分析頁面的截圖，希望後台整體視覺風格改成同樣的側邊欄導覽＋卡片式排版。
  - 單一店家詳細統計頁面 [完成] (9/28) — 在「熱門店家排行」表格把店名改成連結，點進去進到新的 `/admin/stores/:storeId/statistics`：已請款訂單數、總營收（已扣退款）、折扣金額、成團率四張卡片，訂單/營收/折扣趨勢（折線圖＋表格，視窗長度沿用 `getStoreWeeklyTrend` 自己的 `WEEKLY_TREND_WEEKS`，該常數後續從 8 週調整為 13 週，見上方商家端那筆），熱賣飲品前 3 名。直接重用商家端已經寫好、測過的 `merchantStatisticsRepository.getStoreStatistics`（不是重新設計一套算法，管理員跟店家自己看到的數字保證一致），新增 `getStoreWeeklyTrend`（沿用既有 `SALES_ORDER_FILTER`，同樣用 `AT TIME ZONE 'Asia/Taipei'` 分週）與 `storeDirectoryReadRepository.getStoreById`。新增 fake-DB 單元測試 4 項＋擴充 `merchant-statistics-postgres:smoke`（因為這次店家有自己專屬的暫時測試店，改用「精確總數」而非差異驗證，並實測過刻意改壞折扣欄位會讓測試失敗）；`npm test` 205/205 全過，已用瀏覽器點過連結、確認 404（店家不存在）與正常兩種情況都對。事後跑過一次 `/security-review`（管理員可看到任一店家財務資料，屬於後台既有視角的延伸、不是新的揭露範圍），沒有發現問題，記錄在 `docs/AI-security-review-log.md` 2026-09-28 追加的那筆。
    > 呼應使用者「每個商家都有自己的統計」的要求：確認是指後台可以點進單一店家看詳細頁面，不是手機商家端要合併多店統計。
  - 金流資訊總覽頁面 [待處理]
    > 讓管理員在網頁後台能查看每筆訂單完整的付款過程（預授權、確認、請款、退款）與對應金額。這些資料目前都已經存在資料庫裡，只是沒有畫面可以瀏覽，只能直接查資料庫。
    - 畫面需求草稿 《需求》 [待處理]
      > 先畫一個不接真實資料的假畫面，確認這頁該顯示哪些欄位、管理員需要哪些篩選或操作，畫完即丟，不會變成正式畫面的一部分。
    - 開發 《開發》 [待處理]
      > 標籤標在這個中間層，底下子項目自動視為同一階段，不用每個細項各自重複標記。
      - 付款資料查詢邏輯（資料庫） [待處理]
        > 設計要從既有的預授權、請款、退款這幾張資料表撈出哪些欄位，怎麼組合成一筆完整的金流時間軸。
      - 查詢 API（後端） [待處理]
        > 提供給網頁後台呼叫的介面，回傳一筆訂單完整的付款過程資料。
      - 網頁後台顯示畫面（前端） [待處理]
        > 在 `/admin` 網頁後台新增這個查詢頁面，正式接上查詢 API 顯示真實資料。
    - 真實資料人工驗證 《測試》 [待處理]
      > 用真實 PostgreSQL 資料庫裡的訂單，實際打開這個頁面，確認顯示的付款軌跡跟資料庫紀錄一致。
- 本機測試控制台併入主 Backend [完成] (8/23，8/24 補上密碼登入) — 原本是獨立跑在 3100 埠、不進 Git 的 `local-dev-console/`（控制測試顧客的模擬定位、全域模擬業務時間），使用者要求跟管理員後台「整合成同一個工具」後，改為 `backend/devConsole/`，掛在主 Backend 底下的 `/dev-console`；狀態儲存搬到 `backend/data/dev-console-state.json`（沿用同樣不進 Git 的規則）。保留原本「只接受本機（loopback）連線」的邊界不變（用同一個 `isLoopbackRequest` 檢查），不因為併到同一台伺服器就讓區網（例如真手機）連得到；`/admin`、`/dev-console` 兩個頁面互相加了導覽連結。啟動器 `04-start-console.cmd` 改成只開瀏覽器分頁，不再啟動獨立程序；`local-dev-console/` 資料夾保留文件當歷史紀錄，程式不再執行。8/24：使用者確認本機測試控制台「算後台的一部分」，人看的頁面與控制 API 額外要求 `/admin` 的登入 session（loopback 限制照舊，密碼是疊加上去，不是取代），只有 Mobile App 直接呼叫、模擬定位用的 `GET /dev-console/api/app/config`／`POST /dev-console/api/app/report` 兩支維持原本不需密碼；已用真實 HTTP 請求驗證頁面／靜態檔／全部 API（狀態、帳號列表、定位設定讀寫重置、事件紀錄、業務時間讀寫、App 回報）皆正常，`npm test` 70/70 通過（未改動任何被測邏輯），`/security-review` 記錄於 `docs/AI-security-review-log.md` 2026-08-24 這筆
  > 本機開發測試用的工具，可以模擬測試顧客目前在哪裡（方便測試地圖／距離篩選功能）、可以把系統目前的模擬時間往前後調（方便測試截止/取餐時限），只有開發者自己的電腦連得到，正式環境不會出現。
- ECPay 信用卡付款（備援） [完成] (8/27) — 2026-08-26 發現 webhook 缺少 `RtnCode` 檢查與 stage 金鑰 fallback 兩個安全問題、先加總開關暫停；8/27 使用者確認後改為整個移除而非修復——`ecpayService.js`／`ecpayClient.js`／`ecpayAuthorizationRepository.js` 與對應 mobile UI、smoke test、schema CHECK constraint 允許值全部刪除或收回，兩個安全問題隨程式碼刪除一併解決（問題所在的程式碼本身不存在了，不是留著加強防護）；`npm test` 84/84、實際啟動 backend 對真實 PostgreSQL 驗證正常，詳見 `docs/AI-security-review-log.md` 2026-08-26／2026-08-27 兩筆
  > ECPay 原本是 LINE Pay 審核卡關時的備用付款方式；LINE Pay 核准後優先度降低，2026-08-26 發現安全問題後，使用者確認直接整個移除而非修復。目前只有 LINE Pay 一種付款方式。

## 開發協作 [完成]
> 跟寫程式碼本身無關，是幫助多個 AI 助理／開發者之間順利交接、理解專案現況的文件跟規則整理工作。
- AI Agent 漸進式 Context [完成] (8/16) — 已整理 `AGENTS.md`、Claude／Replit 入口、穩定產品 Context 與按需架構文件；Markdown 連結、Context 路由與 `git diff --check` 已驗證
  > 整理一套文件架構，讓不同的 AI 寫程式助理（例如 Claude Code、Codex）進到這個專案時，只需要先讀最基本的規則，需要深入某個主題（例如金流、資料庫）才去讀對應的詳細文件，不用每次都把所有文件全部讀一遍。

- 商家訂單帳號顯示名稱 [進行中] (9/14) — PostgreSQL 訂單回傳 customerDisplayName，App 同步與商家明細／總製作清單使用該名稱；真實資料庫唯讀驗證映射一致，Mobile 語法解析通過，尚待畫面驗證。
  > 店家看見顧客帳號的顯示名稱，不再顯示內部帳號代碼。
