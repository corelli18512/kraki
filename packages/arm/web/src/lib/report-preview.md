# Report preview helper contract

`prepareReportPreview(original: string): Promise<string>` from `./report-preview` is a
browser-only, preview-only transformation. `HtmlArtifactPanel` independently
prepares preview and explicit export documents:

```ts
const previewHtml = await prepareReportPreview(original);
const exportHtml = await withMermaidRuntime(original);
```

Use only `previewHtml` for the blob iframe (`sandbox="allow-scripts"`, without
`allow-same-origin`, referrer policy `no-referrer`). It already contains its own
first-element CSP: do **not** wrap it in the old `withArtifactCsp`, whose script
policy conflicts with nonce-only execution. Preserve the panel's size limit,
cancellation, error reporting and blob revocation. Keep `original` / `exportHtml`
separate; explicit export must never receive `previewHtml`. No automatic export,
system-browser launch, account, transport or real agent command is introduced.

## Boundary and compatibility

- DOMPurify presentation allowlist runs **before** any trusted script insertion.
  No report scripts/modules, event/nonce attributes, meta/link/base, forms,
  frames/objects, MathML, SVG animation/set/foreignObject or report font loads.
- URLs are restricted further to local fragments, and base64 raster data on HTML
  images. Embedded SVG is inline only (not SVG data images). SVG definitions,
  marker references, report styles and data/ARIA attributes are retained.
- Styles remain report-controlled presentation, not trusted script. CSP denies
  network stylesheet/font/image/connect/frame loads. No `unsafe-inline` script,
  report script hashes/nonces, `eval`, report loader URL or script body is used.
- A fresh cryptographic nonce authorizes only Kraki-inserted scripts. Every
  document has an owned fragment/panzoom runtime. Fragment destinations are
  captured in a WeakMap; native anchor click/auxclick defaults are prevented,
  including for subsequently changed hrefs and generated SVG anchors. Local
  sections scroll without navigating a blob URL. Enter activates local links.
- Panzoom uses the template's `data-panzoom`, `.diagram-viewport`,
  `.diagram-canvas`, and button `data-action="in|out|fit|reset"` contract: 1.2x
  buttons, 0.55–3.5 clamp, cursor-centered wheel, pointer pan, fit/reset to 1.
  No report JavaScript is copied into the trusted runtime. The template progress
  script and other arbitrary report interactions do not run.
- Mermaid source uses only the bundled `/vendor/mermaid-11.17.2.min.js`, regardless
  of report-provided `mermaid.initialize`. Strict configuration, no HTML labels,
  no report callbacks. Blocks containing `%%{` directives, initial YAML
  frontmatter, or `click` bindings stay readable source rather than executing
  report configuration/interactions. Invalid diagrams or a missing trusted
  loader also stay source. Generated SVG is DOMPurify-sanitized again before
  insertion; links have no native navigation capability. Trusted render errors
  are not displayed as executable report HTML.

The small export in `report-mermaid.ts`, `loadReportMermaidRuntime()`, exposes the
existing cached fixed-path loader. Existing `withMermaidRuntime(original)` export
semantics (including original self-rendering reports) are unchanged.

## Dependency provenance

Explicit dependency: **dompurify 3.4.17**, the exact version pinned by the
reviewed historical branch, installed offline for this port:

- `https://registry.npmjs.org/dompurify/-/dompurify-3.4.17.tgz`
- `sha512-B/pSlYVHQ58kqISD/yDjuJ1yfzI34m1gF4lAod2bwSRhiN4K5Cl3H8Af7hqB2PmTL911tdEudnnXn5FnhRoz0w==`
- upstream: `https://github.com/cure53/DOMPurify`, MPL-2.0 OR Apache-2.0.
- `dompurify` is used directly for document sanitation; its official packaged
  `dist/purify.min.js?raw` is bundled for generated Mermaid SVG sanitation inside
  the opaque sandbox. No CDN or report-provided sanitizer is loaded at runtime.
- Lock changes add only DOMPurify and its optional `@types/trusted-types`
  dependency. This dependency addition was explicitly approved for the port.

## Checks and limits

Focused tests: `src/lib/report-preview.test.ts` and
`e2e/report-preview-helper/run.mjs`. The browser harness imports the actual
original `withArtifactCsp` only for baseline characterization; the green path
uses this helper directly. It does not mount/integrate the panel.

From `packages/arm/web` (or `pnpm --filter @kraki/arm-web exec`):

```sh
node e2e/report-preview-helper/run.mjs --baseline --characterize # three request+commit controls
node e2e/report-preview-helper/run.mjs --baseline # desired invariant RED (expected nonzero)
node e2e/report-preview-helper/run.mjs # sanitized invariant GREEN + valid controls
```

Use lane-local `PLAYWRIGHT_BROWSERS_PATH` and `env -u NODE_ENV`. The harness builds
a static bundle outside the checkout, binds only 127.0.0.1 port 0, checks a real
HTTP canary control, intercepts all non-exact-origin external traffic/sockets,
then closes only its owned browser and server. Canary requests and frame commits
are recorded independently. Originals are retained without execution as exports.

The helper and `e2e/report-panel/run.mjs` exercise host Chromium only, not
Windows guest, Electron guard, native Mac or installed-app behavior. Negative
network observations last one second after each action, not indefinitely.
Independent review remains required.
