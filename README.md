# DIRT

**Disk Inspection & Removal Tool.** A brutalist disk space visualizer for macOS, with an AI assistant that finds what you can safely clean up.

![Home](docs/home.png)

## What it does

### Drill into your disk
Scan a volume or folder and DIRT draws it as a zoomable sunburst. The middle ring is the top level, biggest first. Click any ring to dive in, click the center to go back up. Every scan is cached for a day, so finished results are still there after a restart.

![Results](docs/results.png)

- Several scans can run at once. They share one thread pool and memory budget, so the machine stays usable.
- `node_modules`, `.git`, caches, app bundles and iPhone backups are totaled as one block via native `du` instead of being walked file by file.
- Shift-click or ⌘-click rows to select in bulk, drag anything to **The Bin**, and move it to the Trash after a confirm. Nothing is deleted outright.

### ✦ What is this?
Right-click any ring or hit **✦ AI** on a row. DIRT tells you what the item is, what created it, whether it's safe to delete, and the right way to reclaim the space. It recognizes git repos and worktrees too.

![What is this?](docs/what-is-this.png)

### ✦ Ask DIRT
Ask in plain English: *"find old installers in Downloads"*, *"which worktrees can I delete?"*. The agent searches with metadata-only tools (names, sizes, dates, Spotlight info, git status) and returns a results page you can filter, bulk-select and send to the Trash.

![Ask DIRT](docs/ask.png)

**The AI never sees file contents.** Only names, paths (home shown as `~`), sizes, dates and git status are sent.

### Git projects
Every repo DIRT finds, with each worktree's last use, size, dependencies and uncommitted/unpushed/merged status. You can diff a worktree against `main`, trash its `node_modules`/`target`, or remove it (changes are stashed first and the branch is kept). **Analyze ✦** has the AI sort a repo's ignored folders into build output you can regenerate versus data you can't.

### Settings
Threads and memory budget for scans, plus your OpenRouter key and model. Model families (DeepSeek, Qwen) always resolve to their newest version, and each one shows its cost per question.

![Settings](docs/settings.png)

## Install

1. Download `DIRT-<version>-universal.dmg` from Releases and drag DIRT to Applications.
2. Open it once. macOS will block it because it isn't notarized.
3. System Settings → Privacy & Security → **Open Anyway**.

For whole-disk scans, add DIRT under System Settings → Privacy & Security → **Full Disk Access**.

The AI features need an [OpenRouter](https://openrouter.ai) API key. Add it in Settings; it's stored encrypted with your macOS Keychain.

## Develop

```sh
npm install
npm run dev     # Electron + Vite with live reload
npm run lint
npm run build   # type-check + bundle the UI
npm run dist    # universal .dmg in release/
npm run icon    # regenerate build/icon.icns
```

Regenerate the README screenshots (uses `/Applications` so nothing personal shows up):

```sh
npm run build && DIRT_SCREENSHOTS=docs OPENROUTER_API_KEY=… npx electron .
```
