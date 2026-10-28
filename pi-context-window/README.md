# pi-context-window

Pi extension：新增 `/context-window` 指令，調整 GPT model 的 context window。

## 安裝

```bash
pi install /Users/vvvdwbvvv/Personal/pi-context-window
```

重啟 Pi 生效。

## 用法

| 指令 | 效果 |
| --- | --- |
| `/context-window` | 互動選單：從預設間距挑選，或選「自訂…」輸入 tokens |
| `/context-window 128k` | 用預設間距（32k / 64k / 128k / 200k / 256k / 400k / 1m） |
| `/context-window 1000000` | 直接指定 tokens（也接受 `1000k`、`1m`） |
| `/context-window 256k openai/gpt-6.1-sol` | 指定要調整的 model（`provider/model` 或唯一 model id） |

未指定 model 時，預設是「目前 session 使用的 model」。

## 寫入位置

調整結果寫入 `~/.pi/agent/models.json`：

- 若該 provider 的自訂 `models` 清單裡有這個 model → 更新該 entry 的 `contextWindow`
- 否則 → 寫入 `providers.<provider>.modelOverrides.<model>.contextWindow`

儲存後重新載入模型設定。如果調整的是目前使用的模型，會立即套用到目前對話，下一次請求即使用新的上下文大小，不需重選模型或重啟，也不清除對話。如果指定其他模型，只更新設定，不切換目前模型。即時套用失敗時會顯示警告；已儲存的設定仍保留。

## 注意

- context window 只是模型層級的大小設定；Pi 的自動壓縮（compaction）門檻仍由 `contextWindow` 與 `settings.json` 的 `reserveTokens` 決定。
- tokens 必須是 >= 1000 的整數。
