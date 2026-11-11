# Contributing

Thanks for helping out. Bug reports, ideas and PRs are all welcome.

## Setup

You need macOS and Node 22 or newer.

```sh
npm install
npm run dev     # Electron + Vite with live reload
```

## Before opening a PR

```sh
npm run lint
npm run build   # type-check + bundle the UI
```

CI runs both on every PR.

## Layout

- `electron/`: main process. Scanning (`scanner.js`, `scan-worker.js`), git (`git.js`), AI (`ai.js`, `agent.js`), IPC (`main.js`).
- `electron/preload.cjs`: the only bridge to the UI. The renderer can call named methods and nothing else.
- `src/`: the UI, plain TypeScript and DOM, no framework.

## Ground rules

- **Never delete outright.** Anything that removes files goes through `shell.trashItem` after a confirm.
- **Never send file contents to the AI.** Names, paths, sizes, dates and git status only. If a change sends something new, say so in the PR and update the *Data & privacy* section of the README.
- Keep PRs focused, one change per PR.

## License

By contributing you agree your work is released under the [MIT License](LICENSE).
