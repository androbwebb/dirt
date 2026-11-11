# DIRT

Disk Inspection & Removal Tool. A macOS disk space visualizer.

## Install

1. Download `DIRT-<version>-universal.dmg` from Releases and drag DIRT to Applications.
2. Open it once. macOS will block it because it isn't notarized.
3. System Settings → Privacy & Security → **Open Anyway**.

For whole-disk scans, add DIRT under System Settings → Privacy & Security → Full Disk Access.

## Develop

```sh
npm install
npm run dev     # Electron + Vite with live reload
npm run lint
npm run build   # type-check + bundle the UI
npm run dist    # universal .dmg in release/
```
