# pi 自動思考等級篩選擴充 (auto-reasoning)

「想用就用」的自動思考等級篩選。用 `/auto-reasoning` 開關，開啟後在**每個新的使用者 prompt**
開始 agent run 之前（`before_agent_start`），用 Inception 的 **Mercury Decide** 分類器判斷 prompt
複雜度，再自動設定 pi 的思考等級（`low` / `medium` / `high` / `xhigh`）。pi 會依目前 provider/模型 clamp
成對應的 reasoning 參數（Inception `reasoning_effort`、GPT `reasoning_effort`、Claude thinking budget…）。

## 支援的模型

**任何 reasoning-capable 的 chat 模型**都適用：Inception Mercury、GPT、Claude 等。
不限定 Inception。

## 用法

| 指令 | 效果 |
|---|---|
| `/auto-reasoning` | 切換開/關（新 session 預設開）|
| `/auto-reasoning on` | 開啟 |
| `/auto-reasoning off` | 關閉 |

狀態會寫入 session（跨重啟、跨 reload 保留）。同一 session 內生效；**新 session 預設開啟**（可用 `/auto-reasoning off` 關閉，之後即記住為關，除非清除該 session 狀態）。

## 運作流程

1. 使用者送出 prompt → `before_agent_start` 觸發（僅 `messageType: "user"`）。
2. 若目前模型是 reasoning chat 模型且開關為 ON，才繼續。
3. 用 `ctx.modelRegistry.classify()` 呼叫 `inception/mercury-decide`，對 `{ prompt }` 打 `score` 問題：
   - `0` = trivial，`1` = moderate，`2` = complex。
4. 映射思考等級：
   | 分數 | 思考等級 |
   |---|---|
   | < 0.7 | `low` |
   | 0.7 – 1.3 | `medium` |
   | 1.3 – 1.7 | `high` |
   | > 1.7 | `xhigh` |
5. `pi.setThinkingLevel(level)`，讓 pi 依模型 capabilities clamp。

## 防呆

- **只處理使用者發起的 turn**：工具呼叫續發不重複觸發。
- **同 prompt 記憶**：同 session 相同 prompt 只判斷一次。
- **分類器不可用 / 出錯**：直接跳過，不動思考等級。
- **限制長度**：只取前 4000 字元。

## 調參

編輯 `index.ts` 的 `THRESHOLDS`：

```ts
const THRESHOLDS = { low: 0.7, medium: 1.3, high: 1.7 } as const;
```

## 測試

```bash
cd ~/.pi/agent/extensions/auto-reasoning
node --experimental-strip-types test.ts
```

覆蓋：命令註冊/切換、GPT/Claude/Inception 三類模型、非 reasoning 跳過、分類器不可用/出錯降級、同 prompt 記憶。

## 安裝

`~/.pi/agent/extensions/auto-reasoning/` 位於 pi 全域擴充目錄，啟動自動載入。

## 型別檢查（開發用）

```bash
node /path/to/typescript/bin/tsc --noEmit -p tsconfig.json
```

`node_modules/` 下的 symlink 只在 `tsc` 解析 pi 型別宣告時需要，pi 執行時用不到。
