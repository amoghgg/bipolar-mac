# Switchboard

A personal terminal workstation for macOS with separate **Office** and **Personal** sections.

- Projects per section; click to open a shell, ✳ to start Claude in it.
- Sessions live in a background service (`ptyd.js`): quitting the app (⌘Q) keeps every shell and
  Claude session running; reopening reconnects with full scrollback. ⌥⌘Q ends them all.
- After a reboot, Claude tabs resume their own conversation (`claude --resume <id>`).
- Waiting-on-you list, notifications and dock badge when Claude finishes or needs permission.
- Splits (⌘D / ⇧⌘D), find (⌘F), jump to anything (⌘P), ⌘1 / ⌘2 to switch sections, ⌘J next waiting session.
- Claude-friendly keys: Shift+↵ newline, ⌥ as Meta, drag files in to paste paths, ⌘-click links.

Config: `~/.config/switchboard/config.json`. Build + install: `npm run package`.

## Precise Claude status (optional)

Without hooks, status is estimated from terminal activity. For exact working / needs-permission /
done states, register the helper with Claude Code by adding this to `~/.claude/settings.json`:

```json
"hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "\"$HOME/.config/switchboard/bin/sb-hook\"", "timeout": 5 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "\"$HOME/.config/switchboard/bin/sb-hook\"", "timeout": 5 }] }],
  "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "\"$HOME/.config/switchboard/bin/sb-hook\"", "timeout": 5 }] }],
  "Notification":     [{ "hooks": [{ "type": "command", "command": "\"$HOME/.config/switchboard/bin/sb-hook\"", "timeout": 5 }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "\"$HOME/.config/switchboard/bin/sb-hook\"", "timeout": 5 }] }],
  "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "\"$HOME/.config/switchboard/bin/sb-hook\"", "timeout": 5 }] }]
}
```

The helper exits immediately outside Switchboard, so other terminals are unaffected.
