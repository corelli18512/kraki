import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HtmlArtifactPanel, exportHtmlReport, withArtifactCsp } from './HtmlArtifactPanel';

const attachment = vi.hoisted(() => ({ status: 'loading', text: null as string | null, error: null as string | null }));
const useText = vi.hoisted(() => vi.fn(() => attachment));
vi.mock('../../hooks/useAttachment', () => ({ useAttachmentText: useText }));
vi.mock('../../lib/report-mermaid', () => ({ withMermaidRuntime: async (html: string) => `${html}<script>/* local Mermaid */</script>` }));
const artifact = { type: 'content_ref' as const, id: 'report-1', mimeType: 'text/html', size: 167_000, name: 'architecture.html', caption: 'Architecture Report' };

beforeEach(() => {
  attachment.status = 'loading'; attachment.text = null; attachment.error = null;
  vi.stubGlobal('TextEncoder', TextEncoder);
  URL.createObjectURL = vi.fn(() => 'blob:report');
  URL.revokeObjectURL = vi.fn();
});

describe('HtmlArtifactPanel', () => {
  it('renders two-line title and toggles pane expansion without browser fullscreen', () => {
    const onClose = vi.fn(); const onToggleExpanded = vi.fn();
    const { rerender } = render(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={onClose} onToggleExpanded={onToggleExpanded} />);
    expect(screen.getByText('Architecture Report')).toBeInTheDocument();
    expect(screen.getByText('Report · 167 KB')).toBeInTheDocument();
    expect(screen.getByText('Loading report…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Browser' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Report' }));
    expect(onToggleExpanded).toHaveBeenCalledOnce();
    rerender(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={onClose} onToggleExpanded={onToggleExpanded} expanded />);
    expect(screen.getByRole('button', { name: 'Restore Split View' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Report' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('rejects metadata oversize without requesting the attachment', () => {
    render(<HtmlArtifactPanel artifact={{ ...artifact, size: 10 * 1024 * 1024 + 1 }} sessionId="s1" onClose={() => {}} />);
    expect(useText).toHaveBeenLastCalledWith(expect.anything(), 's1', expect.any(Function), false);
    expect(screen.getByText('Couldn’t load this report')).toBeInTheDocument();
    expect(screen.getByText('This report exceeds the 10 MB safety limit.')).toBeInTheDocument();
  });
  it('rejects decoded UTF-8 byte oversize even with understated metadata', () => {
    attachment.status = 'ready'; attachment.text = 'é'.repeat(5 * 1024 * 1024 + 1);
    render(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={() => {}} />);
    expect(screen.getByText('This report exceeds the 10 MB safety limit.')).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('shows errors with the native heading/reason', () => {
    attachment.status = 'error'; attachment.error = 'Offline';
    render(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={() => {}} />);
    expect(screen.getByText('Couldn’t load this report')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });
  it('exposes browser export only once the sandboxed report is ready', async () => {
    attachment.status = 'ready'; attachment.text = '<title>Original</title>';
    render(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open in Browser' })).toBeInTheDocument());
    const frame = screen.getByTitle('Architecture Report');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame).toHaveAttribute('src', 'blob:report');
  });
  it('exports a downloadable HTML file in the browser without same-origin script execution', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await exportHtmlReport('<title>Original</title>', '../../report.html');
    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('.._.._report.html');
    expect(anchor.href).toBe('blob:report');
    click.mockRestore();
  });
  it('prepends restrictive CSP before scripts; later report policies can only tighten it', () => {
    const html = withArtifactCsp('<head><script>run()</script><meta http-equiv="Content-Security-Policy" content="default-src *"></head>');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
    expect(html).toContain('default-src *');
    expect(html.match(/Content-Security-Policy/g)).toHaveLength(2);
    const document = withArtifactCsp('\uFEFF  <!doctype html><html><body>ok</body></html>');
    expect(document).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/);
    for (const attack of ['<script>run()</script><head></head>', '<!--<head>--><script>run()</script>']) {
      expect(withArtifactCsp(attack)).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
    }
  });
});
