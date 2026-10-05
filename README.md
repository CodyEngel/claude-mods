# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): plugins of function hooks that add panes, bands, toasts and hooks to the terminal and the desktop Code tab.

## Mods

| Mod | What it does |
| --- | --- |
| [cache-meter](cache-meter) | A band above the prompt showing time left on the prompt cache, how much of the context window is used, a **Compact** button, and an opt-in **Keep warm** toggle that pings the cache before it expires while you're idle (stops after 8 idle hours). |

## Using a mod

```bash
claude --plugin-dir ./cache-meter
```

Each mod's settings live in its `.claude-plugin/plugin.json` under `userConfig`.

## Developing

```bash
claude plugin validate ./cache-meter
claude plugin test ./cache-meter
```

The plugin API is early access and may change between Claude Code releases.
