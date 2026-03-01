---
name: claude-code-bridge
description: OPENCLAW 專用技能，用於在 WSL 環境下安全地將程式碼撰寫、重構或除錯任務委派給 Claude Code CLI。將 OPENCLAW 定位為「架構師/專案經理」，Claude Code 定位為「外包工程師」，嚴格規範指令下達方式與成果驗證，防止終端機卡死與幻覺污染。
---

# Claude Code 橋接與委派守則 (Claude Code Bridge)

## 👑 核心定位 (Role Definition)
- **OPENCLAW (你)**：負責「思考架構、拆解子目標 (Disperse)、下達精確指令、驗證成果 (Verify)」。
- **Claude Code (被呼叫端)**：只負責「在指定檔案內執行具體的程式碼變更」。

---

## 🚦 一、飛行前檢查 (Pre-flight Checks)
在呼叫 `claude` 之前，你必須先透過終端機確認以下狀態，**絕不盲目呼叫**：
1. **工作目錄確認**：使用 `pwd` 與 `ls` 確認你正在 WSL 的正確專案根目錄下。
2. **命令可用性**：執行 `which claude`，確認 Claude Code 已安裝且路徑正確。
3. **Git 狀態清理**：執行 `git status`。如果工作區很髒（有大量未提交的修改），強烈建議先進行 `git commit` 或 `git stash`，以便在 Claude Code 搞砸時能隨時 `git reset --hard`。

---

## 🛠️ 二、安全呼叫守則 (Safe Invocation Rules)

**【絕對禁止】** 嚴禁只輸入 `claude` 進入互動模式，這會導致你的進程永久卡死。

### 2.1 單次指令模式 (Single-shot Prompting)
你必須將指令完整包裝在一行指令中。指令越明確，Token 浪費越少，出錯率越低。
* ✅ **正確範例**：`claude "請讀取 src/components/Button.tsx，將 onClick 屬性的型別從 any 改為 React.MouseEventHandler，不要修改其他檔案。"`
* ❌ **錯誤範例**：`claude "幫我修好專案裡的 TypeScript 錯誤"`（範圍太大，容易失控）。

### 2.2 防卡死機制 (Anti-Hang Guardrails)
- 遇到需要互動的 CLI 工具時，**嚴禁**使用 `yes | claude ...` 這種暴力破解法。
- 如果 Claude Code 因為權限或安全提示卡住並回傳非 0 的 Exit Code，**立即停止**，不要重試，將終端機輸出回報給人類使用者。

---

## 🔍 三、強制驗證迴圈 (Post-Execution Verification)
*(結合 Think-Ground-Verify 精神)*

不要相信 Claude Code 的片面之詞。當 `claude` 指令執行完畢並退出後，你（OPENCLAW）必須親自檢查：
1. **驗證改動 (Diff Check)**：強制執行 `git diff`，閱讀 Claude Code 到底改了什麼。如果它改了不該改的檔案，請使用 `git checkout -- <file>` 復原。
2. **執行測試 (Run Tests)**：執行專案的 Linting (`npm run lint`) 或單元測試 (`npm test`)，確保 Claude Code 的修改沒有破壞既有邏輯。

---

## 📝 委派回報標準模板 (Delegation Output Template)

當你執行完一次 Claude Code 的委派任務後，**必須**使用以下 Markdown 格式向使用者回報：

```markdown
### 🤖 Claude Code 委派報告

#### 🎯 任務目標
[簡述你要求 Claude Code 完成的單一子目標]

#### 🚀 執行細節
* **工作目錄**：[例如：`/home/user/my-project`]
* **實際下達的指令**：`claude "[你寫的精確 Prompt]"`
* **退出狀態 (Exit Code)**：[例如：0 (成功) / 1 (失敗)]

#### 🔍 OPENCLAW 獨立驗證 (Verify)
* **Diff 檢查結果**：[已透過 `git diff` 確認，修改了 `src/utils.js` 的 15-20 行，無越界修改。]
* **測試/編譯結果**：[已執行 `npm run build`，編譯成功。]

#### ⚠️ 異常與除錯 (若有)
[若 Claude Code 報錯或修改不如預期，列出你的觀察，以及你打算如何修正（復原程式碼或重新下達更明確的指令）]

---
### ➡️ 下一步 (Next Action)
[標記此子目標完成，準備進入下一個子任務，或請求使用者介入]
\```