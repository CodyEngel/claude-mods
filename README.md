# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): plugins of function hooks that add panes, bands, toasts and hooks to the terminal and the desktop Code tab.

## Mods

| Mod | What it does |
| --- | --- |
| [cache-meter](cache-meter) | A band above the prompt showing time left on the prompt cache, how much of the context window is used, a **Compact** button, and an opt-in **Keep warm** toggle that pings the cache before it expires while you're idle (stops after 8 idle hours). |
| [pr-monitor](pr-monitor) | A pane listing the repository's open pull requests. Tick the ones to watch to see checks, review state and which other watched branches they conflict with. Mark any **Auto-merge when green** and it merges them one at a time, least-conflicting first, and asks Claude to resolve conflicts (in a temporary worktree, merging rather than rebasing, keeping out of files other watched PRs touch) once nothing else is about to land. |

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
