import type { Config } from 'dompurify';

/** Presentation only. No MathML, embedded browsing contexts, forms or SVG mutation. */
export const REPORT_PREVIEW_POLICY: Config = {
  WHOLE_DOCUMENT: true,
  RETURN_DOM: true,
  ALLOWED_TAGS: ('html head body title style main section article header footer nav aside div span p br hr ' +
    'h1 h2 h3 h4 h5 h6 strong em b i u s small sub sup mark blockquote pre code kbd samp ' +
    'ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td details summary ' +
    'figure figcaption a button img svg g defs symbol use path rect circle ellipse line polyline polygon ' +
    'text tspan textpath marker lineargradient radialgradient stop clippath mask pattern desc').split(' '),
  ALLOWED_ATTR: ('id class style title lang dir role tabindex width height colspan rowspan scope ' +
    'viewBox preserveAspectRatio x y x1 y1 x2 y2 cx cy r rx ry d points dx dy transform ' +
    'fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin ' +
    'stroke-dasharray opacity text-anchor dominant-baseline font-size font-family font-weight ' +
    'marker-start marker-mid marker-end markerWidth markerHeight refX refY orient ' +
    'offset stop-color stop-opacity gradientUnits gradientTransform clip-path clipPathUnits ' +
    'mask maskUnits patternUnits patternTransform href xlink:href src alt type').split(' '),
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  SANITIZE_DOM: true,
};

/** Additional URL policy, not an HTML sanitizer. DOMPurify runs before this. */
export function restrictReportPreviewUrls(root: ParentNode): void {
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name === 'href' || name === 'xlink:href') {
        const value = attribute.value;
        if (!/^#[^\s\u0000-\u001f]*$/.test(value)) element.removeAttribute(attribute.name);
      }
      if (name === 'src' && (element.localName !== 'img' ||
        !/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(attribute.value))) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}
