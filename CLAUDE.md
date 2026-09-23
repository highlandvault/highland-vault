# Highland Vault — Claude instructions

Several developers work on this project in parallel, each with their own clone and Claude session. Claude sessions do not communicate with each other. Shared state lives in this repository and on GitHub.

Before any implementation work, follow the **Claude Collaboration Protocol** in [docs/DEVELOPMENT_RULES.md](docs/DEVELOPMENT_RULES.md#10-claude-collaboration-protocol).

When the developer says "Sync with the Highland Vault project state and continue my assigned task", run that protocol's session-start steps, report what you found, and only then continue.

Do not start a new phase, pick an unassigned task, change architecture, or push to `main` or `develop` unless the owner explicitly asks. Task PRs target `develop` (see DEVELOPMENT_RULES §4).
