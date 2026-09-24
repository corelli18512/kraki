# Pi model scope in Kraki

Since Tentacle 0.31.24, Kraki applies Pi's user-level `enabledModels` to both the Pi model IDs and model details advertised to apps. The catalog still comes from the installed `pi --list-models`; credentials, providers, and Pi itself are not modified.

Example `~/.pi/agent/settings.json` (merge into existing settings):

```json
{
  "enabledModels": [
    "openai-codex/gpt-6-astra",
    "openai-codex/gpt-6-sol",
    "deepseek/deepseek-flash"
  ]
}
```

- Use canonical `provider/modelId` entries to avoid selecting a similarly named proxy model. These select the user's configured official OpenAI Codex provider, not a third-party GPT provider.
- ID patterns support case-insensitive globs, fuzzy model IDs, optional thinking suffixes, and deduplication. Prefer canonical IDs rather than display-name searches: Pi's text catalog does not expose display names.
- Preference order is preserved. For a new session without an explicit model, a nonempty scope's first match is the default, consistent with Pi.
- Missing `enabledModels` or `[]` keeps the unfiltered legacy list. A nonempty scope that matches nothing advertises an empty list rather than unexpectedly enabling other providers.
- `PI_CODING_AGENT_DIR` (including `~/...`) overrides the agent directory. Project-local `.pi/settings.json` is deliberately not used for device-wide capabilities: it is workspace-specific and trust-gated.
- The adapter rereads the preference when capabilities are requested, even when the raw model catalog is cached. The daemon currently loads device capabilities at startup: after changing settings, safely restart Kraki while tasks are idle, then let the app reconnect. Reload/reopen interactive Pi to update its existing UI scope.
- Malformed settings retain an adapter's last valid scope; an invalid initial read advertises no models and logs a warning. Fixing the file allows the next capability read to recover.
- Existing sessions keep their explicit saved models; this is picker/default filtering, not an authorization or credential-revocation mechanism. Claude and Copilot agent model lists are unchanged.

Validation: unit tests cover settings paths, malformed/missing files, exact provider identity, globs, suffixes, duplicate patterns, namespaced IDs, no matches and defaults. A process-level fake Pi verifies both adapter lists and preference edits after raw-catalog caching. The real installed Pi 0.87.1 was also queried without inference: both lists resolved to the three IDs above with per-model thinking levels preserved.
