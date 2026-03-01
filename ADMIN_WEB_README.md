# Gemini 後台網站（Admin Web）

這個後台網站是主對話視窗：左側選擇用戶/對話，右側用聊天 UI 顯示本地 DB 的對話內容，並可真正送訊息到 Gemini。

## 先決條件
- Chrome 已安裝此擴充功能（本專案）
- 你已打開 `https://gemini.google.com/` 並讓擴充功能開始記錄（對話列表才會出現）

## 1) 啟動後台網站
在專案根目錄執行：

```bash
cd admin-web
npm install
npm run dev
```

開啟 Vite 顯示的網址（預設 `http://localhost:5173`）。

## 2) 取得 extensionId
到 `chrome://extensions` → 開啟「開發人員模式」→ 找到你的擴充功能 → 複製「ID」。

把 ID 貼到後台網站右上角的 `Extension ID` 欄位，按「連線」。

## 3) 常見問題
### A. 後台顯示「chrome.runtime 不存在」
- 確認你用的是 **Chrome**（不是其他瀏覽器）\n+- 確認網站是 `http://localhost:*` 或 `http://127.0.0.1:*`\n+- 確認 `manifest.json` 的 `externally_connectable.matches` 允許 localhost（目前已允許）\n+- 重新載入擴充功能後再刷新後台頁面

### B. 對話列表是空的
- 需要先在 Gemini 頁面讓擴充功能跑起來（它會把對話與訊息寫入本地 DB）\n+- 建議：開啟一個對話、讓頁面出現幾則訊息後再回到後台刷新

### C. 後台送出訊息失敗
- 後台送訊息會讓 `background.js` 找到對應的 Gemini 分頁並送出\n+- 若找不到 Gemini 分頁，會自動開一個新分頁到指定對話\n+- 若仍失敗：請先手動打開 Gemini 並登入，再重試

