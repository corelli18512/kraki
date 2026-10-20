# Localization

Kraki's GUI clients are localized; the CLI (tentacle) and relay (head) are not
and should send codes/data, not user-facing sentences. Languages today:
English (source) and Simplified Chinese (`zh-Hans`).

## Language choice

| Client | Default | Switch | Stored |
| --- | --- | --- | --- |
| iOS | system (per-app resolution) | Settings › Language opens Kraki's page in the iOS Settings app (system per-app language picker) | by iOS |
| macOS | system | Settings › General › Language (in-app), relaunch to apply | app-domain `AppleLanguages` |
| Web | browser languages | Settings › General › Language, live | `localStorage['kraki-language']` |
| Windows | as Web (the window is the Web client) | same picker; tray/dialogs follow over IPC `kraki:language` | Web localStorage + shell `prefs.json` |

The choice is per device and is never synced through the relay. Traditional
Chinese (`zh-Hant`, `zh-TW`, `zh-HK`) is not folded into `zh-Hans`.

## Where strings live

| Client | Mechanism | Files |
| --- | --- | --- |
| iOS + macOS (one SwiftUI codebase) | String Catalog | `packages/arm/ios/Kraki/Resources/Localization/{Localizable,InfoPlist}.xcstrings` |
| Web | i18next / react-i18next, one JSON per namespace | `packages/arm/web/src/i18n/locales/<lang>/<namespace>.json` |
| Windows shell (tray, dialogs, toasts) | small dictionary | `packages/desktop/src/i18n.cjs` |

English is the source in every client. Each client keeps its own files: the
Apple catalog is keyed by English literals and extracted by Xcode, Web uses
semantic keys; consistency across clients comes from the [glossary](localization-glossary.md)
and `pnpm l10n:check`.

## Writing UI code

**Swift**
- `Text("Archive")`, `Button("Retry")`, `Label("Settings", systemImage:)`,
  `Toggle`, `Section`, `.navigationTitle`, `.alert` take
  `LocalizedStringKey`: literals are localized automatically.
- A `String` that ends up on screen: `String(localized: "Couldn't load image")`.
  Model/enum copy: return `LocalizedStringResource` (or `LocalizedStringKey`).
- Interpolate, don't concatenate: `Text("Last online \(date)")` → key
  `Last online %@`. Never build sentences from fragments.
- Counts: write `Text("\(n) sessions")` and add plural variants in the
  catalog (Xcode: "Vary by Plural").
- Dates/relative time: `KrakiFormat.relative`, `Date.formatted()`,
  `RelativeDateTimeFormatter`; never `"\(m)m ago"`.
- Names that must not be translated (agent names, device names, user
  content, code): `Text(verbatim:)`.
- Logs, diagnostics, accessibility identifiers: plain strings, not localized.

**Web**
- `const { t } = useTranslation('settings'); t('language.label')`; outside
  React `import { t } from '../i18n'`.
- Add keys to `locales/en/<ns>.json` and every other locale; new namespaces
  go in each locale's `index.ts`. Keys are typed (`i18next.d.ts`).
- Plurals: `t('sessions.count', { count })` with `_one`/`_other` keys
  (zh only needs `_other`).
- Rich text: `<Trans>` from react-i18next.
- Time/number/list: `src/i18n/format.ts` (`formatRelativeTime`,
  `formatDateTime`, `formatNumber`, `formatList`).
- Unit tests run in English (`src/test/setup.ts`), so assertions on English
  copy keep working.

**Windows shell**: `i18n.t('tray.open')`; add the key to every dictionary.

## Checks

```
pnpm l10n:check            # CI: key/placeholder parity + ratchet
pnpm l10n:check --verbose  # list untranslated / hard-coded strings
pnpm l10n:check --update   # lower the baseline after migrating strings
pnpm l10n:check --strict   # release gate: zero untranslated / hard-coded
pnpm l10n:extract:apple    # sync the String Catalogs with Swift code (xcodebuild)
```

Hard errors: missing/extra keys, changed placeholders, empty translations.
The ratchet (`scripts/l10n/baseline.json`) lets the untranslated Apple keys
and the heuristically detected hard-coded English in `.tsx`/`.swift` only go
down. Hidden diagnostics/debug surfaces are excluded from the heuristic and
stay English.

Building in Xcode updates the catalog automatically; on the command line run
`pnpm l10n:extract:apple` after changing Swift copy.

## Adding a language

1. Web: add it to `src/i18n/languages.ts`, add `locales/<code>/`, register
   it in `resources.ts`; extend `matchLanguageTag` if the tag needs mapping.
2. Windows shell: add a dictionary to `packages/desktop/src/i18n.cjs` and
   extend `matchLanguage`.
3. Apple: add a case to `AppLanguage` and translate the catalogs (Xcode adds
   the region; `xcodegen` picks it up from the catalogs). Add SwiftUI's
   localized "File" menu title to `MacAppDelegate.removeUnwantedMenus`
   (from SwiftUI's `MainMenu.loctable`, e.g. zh_CN 文件).
4. Extend the glossary, run `pnpm l10n:check --strict`, and check layouts with
   screenshots (`packages/arm/web/e2e/settings-language.check.mjs`).
