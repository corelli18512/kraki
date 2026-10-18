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

The retained processed short/long contracts currently fail their strict iframe
width-delta assertion: expansion removes a 1px border, giving 201px rather than
200px growth. Their height delta is 100px. Do not weaken those assertions or
change CSS to manufacture a passing result; the historical contract needs owner
adjudication. Bare and structural geometry plus all three preview/export
boundaries pass on host Chromium. Windows native resize remains unverified.

The preview security/runtime and export contracts also run independently through
`e2e/report-preview-helper/run.mjs` and `e2e/report-panel/run.mjs`.
