# DrinkGroupBuy Mobile

這是 DrinkGroupBuy 的 Android-first mobile app，目前用 React Native + Expo 開發。

目前開發方式是：最後目標偏 Android App，但現在也支援 Expo Web，方便在電腦瀏覽器展示與測試。

## 目前定位

這不是單純 mock 前端了，現在已經開始和本機 backend / SQLite 串接。

目前已接上的功能：

- Firebase Google Login 入口；本機 dev mode 可用測試身份下拉選單切換顧客與商家流程。
- 顧客首頁、活動詳情、即時地圖、菜單、購物車、我的訂單與取餐資訊；活動與顧客店家摘要已接 Backend。
- 商家建立團購活動，會呼叫 backend API。
- 顧客送出購物車，會呼叫 backend 建立訂單。
- 付款頁可以呼叫 backend 建立 LINE Pay sandbox 預授權付款連結。
- 管理員取消團購，會呼叫 backend API。

目前仍未完成：

- 正式 Firebase / Google 設定與測試帳號 UID 對應仍需依環境完成。
- LINE Pay 分離式請款 Sandbox 人工端對端驗證，以及 capture／settlement PostgreSQL building block 的 server／scheduler 接線。
- 正式商家退款申請與營運審核流程；目前 refund 只有開發／補救 Backend API。
- LINE Pay webhook 第一版不是必要入口；目前依 confirm／cancel redirect、polling 與 provider reconciliation。
- 截止後專用最終結算快照畫面。
- 正式 Android 打包上架流程。

## 安裝依賴

第一次下載專案後，在專案根目錄執行：

```powershell
cd mobile
npm install
```

同一台電腦通常只需要執行一次。

## 開啟 Web 預覽

從專案根目錄執行：

```powershell
npm run mobile:web
```

常用網址：

```text
http://localhost:8083
```

如果改過 `.env`，請完整停止並重啟 Expo。

## 開啟 Android 預覽

從專案根目錄執行：

```powershell
npm run mobile:android
```

可以用 Android Emulator，或在 Android 手機安裝 Expo Go 後掃描 QR code。

Expo Go 適合一般畫面與流程預覽，但不會套用本專案 `app.config.js` 的 Android Google Maps API key。要驗證 Android 原生 Google 地圖圖磚，請改用專案 Development Build：

```powershell
cd mobile
npx expo run:android
```

首次執行會在本機產生已被 Git 忽略的 `mobile/android/`，並安裝 `com.drinkgroupbuy.prototype` 到目前的 Android Emulator。Google Cloud 的 Android key 必須允許此 package name 與本機 debug SHA-1。

## 環境變數

本機 mobile 設定檔：

```text
mobile/.env
```

範本：

```text
mobile/.env.example
```

常見內容：

```env
GOOGLE_MAPS_API_KEY=your_restricted_android_google_maps_api_key
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=your_http_referrer_restricted_web_google_maps_api_key
EXPO_PUBLIC_BACKEND_URL=http://localhost:3000
EXPO_PUBLIC_AUTH_MODE=firebase
# EXPO_PUBLIC_AUTH_MODE=dev
EXPO_PUBLIC_FIREBASE_API_KEY=your_firebase_web_api_key
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
EXPO_PUBLIC_FIREBASE_PROJECT_ID=your_firebase_project_id
EXPO_PUBLIC_FIREBASE_APP_ID=your_firebase_app_id
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=your_android_oauth_client_id.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=your_web_oauth_client_id.apps.googleusercontent.com
```

## Google Maps key 差異

| 變數 | 用途 |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | Android 原生地圖用 |
| `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` | Web 預覽地圖用 |

`EXPO_PUBLIC_` 開頭的變數會進入前端 bundle，所以不能放密碼或真正機密。

### 本機定位控制台

`EXPO_PUBLIC_DEV_CONSOLE_URL` 只在開發 build 且 `EXPO_PUBLIC_AUTH_MODE=dev` 時使用。控制台已併入主 Backend（`backend/devConsole/`，路徑 `/dev-console`），不再是獨立的 3100 埠服務。Android Emulator 連回電腦使用 `http://10.0.2.2:3001/dev-console`；同一台電腦的 Web 預覽使用 `http://127.0.0.1:3001/dev-console`。

App 會依目前登入的 Backend `userId` 每 5 秒讀取個別定位設定：固定模式直接套用座標，即時模式使用 GPS。控制台無法連線時，App 會保留最後一次成功設定；首次連線失敗則使用台中科大預設。

Google Maps API key 可以放在 mobile，但要到 Google Cloud Console 設限制：

- Android key：限制 package name 和 SHA-1。
- Web key：限制 HTTP referrer，例如 `http://localhost:*/*`。

## Backend URL

`EXPO_PUBLIC_BACKEND_URL` 是 mobile 呼叫 backend 的網址。

本機通常是：

```env
EXPO_PUBLIC_BACKEND_URL=http://localhost:3000
```

Expo Web is fixed to `http://localhost:8083` in local development so Google OAuth and Maps referrer settings stay stable.

如果你用 Android 實機測試，`localhost` 會指向手機本身，不是電腦。那時要改成電腦區網 IP 或 tunnel URL。

## 推播通知（Android）設定

Android 的推播要靠 Google 的 Firebase Cloud Messaging（FCM）。打包前需要兩樣東西，缺任何一樣，App 都取不到推播 token（程式會靜默略過，不會報錯，只是收不到通知）：

1. `mobile/google-services.json`：到 Firebase 控制台的專案設定 → 你的應用程式 → Android 應用程式（套件名稱 `com.drinkgroupbuy.prototype`）下載，放在 `mobile/` 底下。這個檔案不進 Git（已在 `.gitignore`），`app.config.js` 偵測到檔案才會啟用。
2. FCM 金鑰：Firebase 專案的服務帳戶私密金鑰，用 `eas credentials` 上傳到 Expo 帳號（互動式指令，Android → Google Service Account → FCM V1）。這是機密，不要放進專案。

這兩項都是原生層設定，改了之後要重新打包 APK，EAS Update 無法讓它生效。本機打包流程：`cd mobile && npx expo prebuild --platform android --no-install`（不要加 `--clean`，會洗掉 `android/app/debug.keystore` 而讓簽章指紋改變、Google 登入失效），再 `cd android && ./gradlew.bat assembleRelease`；輸出在 `android/app/build/outputs/apk/release/app-release.apk`。打包時不要帶 `EXPO_PUBLIC_DEMO_MODE`。

## 離線展示模式

`EXPO_PUBLIC_DEMO_MODE=true` 會讓 App 完全不連後端：登入頁（樣式與正式版一致）可一鍵以顧客或店家身份進入，菜單、團購、統計、開團、新增飲品、送出訂單都改用 `src/mock/demoContent.js` 與 `src/mock/demoBackend.js` 的假資料，不寫入任何真實資料庫。用途是專題展或試玩時讓人直接操作介面。

只在命令列暫時帶入，**不要寫進 `mobile/.env`、`eas.json` 或 EAS 環境變數**——旗標是建置時寫死的，寫進去之後打出來的 APK 或發出去的 EAS Update 會整包變成假資料版：

```bash
cd mobile
EXPO_PUBLIC_DEMO_MODE=true npx expo start --web --port 8083
```

要讓不同網路的人掃 QR code 連進來，加上 `--tunnel`（需要先 `npm install -g @expo/ngrok`，並到 ngrok 申請免費帳號、執行 `ngrok authtoken <你的授權碼>`；這台電腦要保持開機，網址跟著這個連線）。

限制：假資料重新整理就重置；展示模式沒涵蓋的畫面（例如退款、商家申請）仍會嘗試連後端；取消訂單、標記可取餐、取餐核銷、取消團購只有本機模擬。登入頁在展示模式下不會取得任何 token，後端的授權邏輯完全沒有改動。

## Firebase Google Login

Mobile now uses Firebase Auth with Google Login as the primary login path. The app sends the Firebase ID token to `POST /api/auth/firebase-session`, and the backend decides the user role from `users.firebase_uid`, `user_roles`, and `merchant_users`.

For local testing with only one Google account, set backend `AUTH_DEV_MODE=true` and mobile `EXPO_PUBLIC_AUTH_MODE=dev`. The login screen will show a dev-only identity dropdown populated from the local SQLite users and roles. Do not use that mode for production builds.

Required setup:

- Create a Firebase project and enable Google sign-in.
- Add Android OAuth client settings for package `com.drinkgroupbuy.prototype`.
- Put only public Firebase app config and OAuth client IDs in `mobile/.env`.
- Configure backend Firebase Admin credentials in `backend/.env` or root `.env`.
- Update the development database so each Google test account UID is stored in `users.firebase_uid`.

## LINE Pay 注意事項

LINE Pay 的通路密鑰不能放在 `mobile/.env`。

正確位置是：

```text
backend/.env
```

mobile 只會呼叫 backend，真正簽章和密鑰都由後端處理。

## 建議本機啟動順序

從專案根目錄執行：

```powershell
npm run db:init
npm run db:seed
npm run backend:start
npm run mobile:web
```

如果已經初始化過資料庫，不一定每次都要跑 `db:init` 和 `db:seed`。

## 測試完整付款前的提醒

LINE Pay 預授權流程要求：

1. 團購活動存在於 backend SQLite。
2. 顧客購物車送出後，backend 成功建立 `orders`。
3. 付款頁才可以建立 LINE Pay request。

如果你用的是舊的 mobile localStorage 團購，backend 可能會回：

```text
Group-buy activity not found
```

這代表那筆團購只存在前端本機，不在資料庫。請先用商家頁重新建立一筆團購。

## 重要安全提醒

- 不要上傳 `mobile/.env`。
- 不要把 LINE Pay 通路密鑰放到 mobile。
- 不要把真的 API key 寫進 `.env.example`、README 或 source code。
- 改 `.env` 後要重啟 Expo。

## 仍保留的開發 fixture

目前 mobile 仍保留部分開發身份、訂單與商家／補救畫面 fixture：

```text
src/mock/groupBuyActivities.js
src/mock/orders.js
src/mock/paymentAuthorizations.js
```

顧客首頁、活動詳情、地圖、顧客訂單、取餐資訊、商家儀表板、商家開團與開發補救畫面已全面改用 `GET /api/stores`（`appState.stores`）作為店家資料來源；`src/mock/stores.js` 已移除。`src/mock/databaseMapStores.js`（舊測試工具匯出用途、runtime 早已不讀取）已於 2026-09-17 移除。`groupBuyActivities.js` 保留為空的相容檔，不再提供初始活動。`src/mock/drinks.js`、`src/mock/customerUsers.js`（舊的靜態飲品/客戶原型資料，畫面早已改用真實菜單與登入資料）已於 2026-09-17 移除。
