# Security

DIRT moves files to the Trash, runs with Full Disk Access, and stores an API key, so security reports matter.

## Reporting a vulnerability

Please **don't open a public issue.** Report it privately through GitHub instead:
[Report a vulnerability](https://github.com/androbwebb/dirt/security/advisories/new).

Include what you found, how to reproduce it, and which version you tested. You'll get a reply within a week.

## Supported versions

Only the latest release gets fixes.

## Especially interesting

- Anything that could delete files outright instead of moving them to the Trash, or trash something the user didn't select.
- Ways for scanned file names or paths to inject instructions into the AI and cause it to pick files the user didn't ask about.
- Leaking file contents or the API key to OpenRouter or anywhere else.
- Escaping the renderer sandbox through the IPC bridge (`electron/preload.cjs`).
