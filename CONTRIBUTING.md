# Contributing to Kraki

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

- **Questions and ideas:** [Discussions](https://github.com/corelli18512/kraki/discussions)
- **Bugs:** [open an issue](https://github.com/corelli18512/kraki/issues/new/choose) and include the
  diagnostics from Settings → About → Copy Diagnostics
- **Security problems:** see [SECURITY.md](SECURITY.md) — never in a public issue

## Before a larger change

Open an issue or discussion first, so we can agree on the approach before you spend time on it.
Small fixes can go straight to a pull request.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/tentacle` | The `kraki` CLI and background service next to your agents (Claude Code, Codex, Copilot, Pi adapters) |
| `packages/head` | The relay server |
| `packages/protocol`, `packages/crypto`, `packages/pulse` | Shared message types, encryption and the reliable transport |
| `packages/arm/web` | The web app (also the UI of Kraki for Windows) |
| `packages/arm/ios` | Kraki for Mac and the iPhone app (SwiftUI/AppKit/UIKit) |
| `packages/desktop` | Kraki for Windows (Electron shell) |
| `packages/voice-broker`, `packages/monitor` | Cloud voice gateway and the diagnostics collector |
| `packages/tests` | Integration tests |

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Development

```bash
pnpm install
pnpm dev            # local relay + real Kraki daemon + web app, isolated from your real setup
pnpm validate       # full TypeScript check and tests
```

Run focused tests for what you changed; [docs/testing.md](docs/testing.md) covers the native
(Mac/iPhone) tests and device safety. `pnpm -w lint` must pass.

## Pull requests

- Keep each pull request to one change, with a clear description of what and why.
- A bug fix comes with a test that fails before the fix and passes after.
- **Compatibility:** people run older apps and relays. Protocol and storage changes must keep
  working with released versions.
- User-visible text goes through the localization catalogs (`node scripts/l10n/check.mjs`).
- If you add or change something people can see, update [FEATURES.md](FEATURES.md).

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
