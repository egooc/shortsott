# OpenCode Project Memory

## Model Split Policy

- Main default model: `openai/gpt-5.5`
- Subagent model for `general`, `explore`, `librarian`, `oracle`, `metis`, `momus`, `multimodal-looker`, `prometheus`, and `Sisyphus-Junior`: `openai/gpt-5.4-mini`

Keep this split as the project default for future OpenCode config edits unless the user explicitly asks to change it again.

When updating `.opencode/config.json`, preserve the main/default `openai/gpt-5.5` setting and re-check that every listed subagent still points to `openai/gpt-5.4-mini`.
