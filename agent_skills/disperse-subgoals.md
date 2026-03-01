---
name: disperse-subgoals
description: OPENCLAW 的任務降維與規劃引擎。當接收到多步驟任務、架構重構、或超過 3 個邏輯依賴的指令時強制觸發。負責將模糊的主目標拆解為可獨立驗證的微小步驟。
---

# 分散子目標 (Disperse Subgoals)

> ⚠️ 本技能僅負責「規劃」。執行紀律（驗證協議、錯誤閥值、溝通鐵則）遵從 SOUL.md。
> 執行階段的思考框架（Think-Ground-Verify）參見 `think-ground-verify` 技能。

---

## 六步拆解流程 (The 6-Step Breakdown)

### 1. 鎖定單一主目標 (Lock Main Goal)
- 主目標必須是**一句話**可說清的最終結果。
- 剃除雜訊：不要把「順便優化 UI」或「順便升級套件」塞進同一任務。無關需求列為 `[擱置/另開任務]`。

### 2. 定義可交付子目標 (Deliverable Micro-steps)
每個子目標必須對應一個**可驗證狀態**或**具體產出**：
- ✅ 「後端實作 `GET /api/export` 並通過單元測試」
- ❌ 「處理匯出邏輯」（太模糊，無法驗證何謂完畢）

### 3. 嚴格依賴排序 (Dependency Sorting)
- 列出**誰依賴誰**（先有 Schema → 才能寫 API → 才能接前端）。
- 子目標的執行順序 = 依賴順序。嚴禁在底層未驗證前寫表層。

### 4. 限制爆炸半徑 (Scope Slicing)
- 一個子目標 ≈ 一個檔案的一層改動。
- 若一個子目標內部覺得太複雜，**立刻再往下拆為 3 個微步驟**。

### 5. 狀態機追蹤 (Strict Todo Tracking)
- 狀態僅限三種：`[Pending]`, `[In Progress]`, `[Completed]`。
- 同一時間**只允許一個**子目標處於 `[In Progress]`。

### 6. 防幻覺濾網 (Anti-Hallucination Filter)
- 只拆解「達成主目標真正需要」的步驟。絕不發明未來需求。
- 在寫下子目標前，先透過 `ls` 或 `grep` **確認該模組真的存在**，不要憑空想像專案結構。

---

## 強制計畫輸出模板 (Plan Output Template)

啟動此技能時，**必須**輸出以下格式：

```markdown
### 🗺️ 執行藍圖 (Execution Plan)

* **主目標**：[一句話精準描述]
* **環境確認**：已透過 `[終端機指令]` 確認相關目錄與核心檔案存在。

#### 📋 子任務清單 (Todo List)
*(嚴格遵守依賴順序，一次只執行一項)*

1. `[In Progress]` **[子目標名稱]**
   - **目標檔案**：`src/path/to/file.ts`
   - **驗證標準**：[例如：執行 `npm test` 預期 Exit Code 為 0]
2. `[Pending]` **[子目標名稱]**
   - **依賴**：需等待步驟 1 完成。
   - **驗證標準**：[具體驗證方式]
3. `[Pending]` **[子目標名稱]**
   - **驗證標準**：[具體驗證方式]

---
### ➡️ 下一步 (Next Action)
[直接開始執行步驟 1，進入 Think-Ground-Verify 迴圈。無需等待人類回覆「好」。]
```
