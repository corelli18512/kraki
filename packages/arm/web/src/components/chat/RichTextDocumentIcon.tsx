import type { SVGProps } from 'react';

/** Cross-platform doc.richtext: a rounded document with letter, text and image. */
export function RichTextDocumentIcon(props: SVGProps<SVGSVGElement>) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <rect x="4.5" y="2" width="15" height="20" rx="2" />
    <path d="m7 10 1.7-4 1.7 4M7.7 8.5h2M13 6h3.5M13 9h3.5" strokeWidth="1.2" />
    <rect x="7" y="12" width="10" height="7" rx=".6" fill="currentColor" strokeWidth=".8" />
    <path d="m7.5 17 2.7-2.7 2.1 2 1.4-1.1 2.8 2.3v1h-9Z" fill="var(--color-surface-primary, #fff)" stroke="none" />
  </svg>;
}
