# Research Planner — agent entry point

- This is the standalone Obsidian plugin, version 0.3.2. The GitHub repository is daily-planner; the plugin ID remains research-planner. Do not rename its installation directory or queue paths.
- For deployment, read docs/INSTALL.md first. No original Windows workspace, WSL, sibling repository or migration archive is needed. Read docs/REQUIREMENTS.md and docs/VALIDATION.md before code changes.
- A request to deploy authorizes necessary installation steps in that guide. Identify the intended Vault and its actual config directory; ask if several Vaults are ambiguous. Preserve existing notes, settings, templates, plugin data and sync configuration. Installation does not authorize accepting schedules or testing with real notes.
- examples/plugin-settings.example.json includes the user's existing non-secret API base URL and a model placeholder. Reuse it only for that provider. A key and model name cannot identify an arbitrary provider; never send keys to guessed endpoints.
- Store keys through Obsidian SecretStorage. Never place them in source, data.json, command arguments, logs, reports, Git or packages. Without secure UI control, finish other deployment steps and clearly report the remaining SecretStorage step.
- Use Node.js 22 and npm: npm ci, npm test, npm run build. On Windows use npm.cmd if npm.ps1 is blocked. Building needs no Python or WSL. npm run package:windows makes a ZIP on Windows; npm run package additionally needs Python 3.
- Test writes only in synthetic Vaults under ignored .test-runtime/. Optional test:live consumes quota and takes API_BASE_URL, API_KEY, MODEL_NAME from environment variables. Do not run it merely to install. GUI scripts require an explicitly configured executable and isolated profile.
- Preserve hierarchy, sibling order, stable identity, checked states, manual confirmation, bounded catch-up, concurrent-edit checks and rollback. Undated tasks go to the selected day; capacity never authorizes postponement. Identity, ancestry and completion receipts live in the version 2 future queue, not inline task IDs.
- Preserve unrelated diary content. Completed tasks can contain explicit follow-ups, but completion is not permission to invent work. All devices sharing a Vault need compatible versions.
- Distinguish unit, live API, GUI and multi-device validation; historic Linux tests are not current Windows/Android/LiveSync evidence.
- Keep machine-specific handoffs, Vault backups, screenshots and credentials out of commits. Do not invent a Git author or rewrite remote history.

- Default UI source is the most recent manually maintained TODO, even on an already-reviewed date. Search at most 30 days; do not merge older checklist versions. Keep the explicit range mode as an advanced option. Overdue queued work goes to the selected day unless the user explicitly leaves it unassigned. Preserve wasChecklist metadata so clearing a known checklist never revives older tasks.
