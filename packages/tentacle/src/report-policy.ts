/**
 * Policy for `show_report`: Kraki's report viewer is for written reports —
 * prose, tables, inline SVG and Mermaid source that the client renders — not a
 * web browser or media player. Every report is relayed to each online device
 * over a narrow relay link, so size is bounded and heavyweight embeds are
 * rejected with an actionable message the agent can fix and retry.
 *
 * Measured basis (2026-09-28): text-only reports are median 24 KB, p99 177 KB,
 * max 505 KB; a report with six complex Mermaid diagrams is ~7 KB. Oversized
 * reports were video (45%), PNG/JPEG/GIF (50%) and a 3.5 MB inlined Mermaid
 * library — none of which the native viewer can use (its CSP blocks media).
 *
 * The validator is plain JavaScript source so the materialized Pi extension
 * (which cannot import tentacle modules) and the TypeScript tests share one
 * implementation. It must not contain backticks or `${`.
 */

export const REPORT_MAX_BYTES = 1024 * 1024;
export const REPORT_MAX_RASTER_BYTES = 200 * 1024;
export const REPORT_MAX_SCRIPT_BYTES = 64 * 1024;

export const REPORT_VALIDATOR_SOURCE = String.raw`function krakiValidateReport(bytes) {
  var kb = function (n) { return Math.max(1, Math.round(n / 1024)) + " KB"; };
  if (bytes.length > 1048576) {
    return "the report is " + kb(bytes.length) + "; the limit is 1 MB. A report is text: prose, tables, inline SVG and Mermaid source. Remove embedded images, video, audio and inlined libraries (Kraki renders Mermaid itself).";
  }
  var html = bytes.toString("utf8");
  if (/<(video|audio)\b|data:(video|audio)\//i.test(html)) {
    return "the report embeds video or audio, which the Kraki report viewer cannot play. Remove it and describe the result in text; send key frames with show_image if they matter.";
  }
  var m;
  var script = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = script.exec(html))) {
    if (m[1].length > 65536) {
      return "the report inlines a " + kb(m[1].length) + " script (a library such as Mermaid?). Do not inline libraries: write diagrams as <pre class=\"mermaid\">...</pre> and Kraki renders them.";
    }
  }
  if (/<(script|img|iframe|link|source|embed|object)\b[^>]*\b(src|href)\s*=\s*["']?\s*(https?:)?\/\//i.test(html)) {
    return "the report loads external resources, which the Kraki report viewer blocks. Keep CSS and SVG inline and write diagrams as Mermaid source.";
  }
  var raster = 0;
  var image = /data:image\/(png|jpe?g|gif|webp|bmp|tiff|avif|heic)[^"')\s]*/gi;
  while ((m = image.exec(html))) raster += m[0].length;
  if (raster > 204800) {
    return "the report embeds " + kb(raster) + " of raster images (limit 200 KB). Send screenshots or photos with show_image, and draw diagrams as inline SVG or Mermaid.";
  }
  return null;
}`;

type ReportValidator = (bytes: Buffer) => string | null;

const compiled = new Function(`${REPORT_VALIDATOR_SOURCE}\nreturn krakiValidateReport;`)() as ReportValidator;

/** Returns null when the report is acceptable, else a message for the agent. */
export function validateReportHtml(bytes: Buffer): string | null {
  return compiled(bytes);
}
