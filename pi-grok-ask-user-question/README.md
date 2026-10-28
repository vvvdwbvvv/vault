# pi-grok-ask-user-question

Pi package for grok-build's `AskUserQuestion` card. The model calls `AskUserQuestion`; the tool blocks until you answer, cancel, or the shared timer fires. Cancel and timeout are normal results, not tool errors.

```bash
pi install /Users/vvvdwbvvv/Personal/pi-grok-ask-user-question
```

Restart Pi. This does not replace `@juicesharp/rpiv-ask-user-question` (`ask_user_question`). Remove that package if you only want this card.

## Card

- Options plus an automatic `Other` row (`z` or Enter).
- `↑↓` / `jk` move, `1-9` / `a-f` pick, `←→` / `hl` change question, Space toggles multi-select, Enter advances, Esc cancels.
- Plan mode adds **Respond to agent** and **Finish plan interview**. Turn it on with `PI_ASK_USER_QUESTION_MODE=plan` or `pi.events.emit("plan-mode", { enabled: true })`.
- One timer for the whole questionnaire. Default 30 minutes. `PI_ASK_USER_QUESTION_TIMEOUT_SECS` (or `GROK_ASK_USER_QUESTION_TIMEOUT_SECS`) overrides it. `PI_ASK_USER_QUESTION_TIMEOUT=off` waits forever. `0` does not.
- Print / JSON with no UI returns the no-operator text. RPC uses the host select dialog.

Result strings match grok-build `format.rs` (accepted, chat-about-this, skip-interview, cancel).
