# Historical report layout contracts

These are test-only ports. Main's panel geometry CSS is unchanged; the historical
layout branch contained no production layout fix.

From `packages/arm/web`, run:

```sh
REPORT_LAYOUT_OUTPUT=/tmp/a-new-report-layout-run node e2e/report-layout/run.mjs
```

The output directory must not already exist. The runner builds three separate
contexts: bare panel, panel with actual processed app CSS, and manually assembled
app wrappers with actual CSS. The last is not a mounted App/Router or Electron.

The processed short/long contracts require exactly 201px of iframe width growth:
actual preflight uses border-box, so the initial 1000px panel includes a 1px left
border and its iframe is 999px wide. Production expansion intentionally removes
that border, making the resized iframe 1200px wide. This is border accounting,
not subpixel rounding. The test also verifies that the border changes from 1px
to 0px. The bare content-box fixture keeps its exact 200px expectation; both
contexts still require exactly 100px height growth and exact restoration. No
production CSS was changed. All nine geometry and preview/export contracts must
pass on host Chromium. Windows native resize remains unverified.

The preview security/runtime and export contracts also run independently through
`e2e/report-preview-helper/run.mjs` and `e2e/report-panel/run.mjs`.
