import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { prepareReportPreview } from '../../lib/report-preview';
import { HtmlArtifactPanel, exportHtmlReport, withArtifactCsp } from './HtmlArtifactPanel';
import { ChatHeader } from './ChatHeader';

const attachment = vi.hoisted(() => ({ status: 'loading', text: null as string | null, error: null as string | null }));
const useText = vi.hoisted(() => vi.fn(() => attachment));
vi.mock('../../hooks/useAttachment', () => ({ useAttachmentText: useText }));
vi.mock('../../lib/report-mermaid', () => ({ withMermaidRuntime: async (html: string) => `${html}<script>/* local Mermaid */</script>` }));
vi.mock('../../lib/report-preview', () => ({ prepareReportPreview: vi.fn() }));
const artifact = { type: 'content_ref' as const, id: 'report-1', mimeType: 'text/html', size: 167_000, name: 'architecture.html', caption: 'Architecture Report' };

beforeEach(() => {
  attachment.status = 'loading'; attachment.text = null; attachment.error = null;
  vi.mocked(prepareReportPreview).mockReset().mockResolvedValue('<title>Safe preview only</title>');
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
  it.each([false, true])('K-213: Escape closes only the mode menu, not the report under it (narrow=%s)', (narrow) => {
    const onClose = vi.fn();
    render(<><HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={onClose} /><ChatHeader title="Session" mode="auto" narrow={narrow} onMode={() => {}} /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Session mode, Auto' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('K-213: an Escape that cancels an IME candidate leaves the mode menu open', () => {
    render(<ChatHeader title="Session" mode="auto" narrow={false} onMode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session mode, Auto' }));
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(window, { key: 'Escape', keyCode: 229 });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('leaves the report open when Escape belongs to an image preview above it', () => {
    const onClose = vi.fn();
    const { rerender } = render(<><HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={onClose} /><div className="kimage-viewer" /></>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
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
  it('keeps original scripts only in explicit export, never in the preview blob or an automatic download', async () => {
    const original = '<h1>Original</h1><script>location="http://127.0.0.1:1/inert-only"</script>';
    attachment.status = 'ready'; attachment.text = original;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Open in Browser' });
    expect(prepareReportPreview).toHaveBeenCalledWith(original);
    expect(click).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    const readBlob = (blob: Blob) => new Promise<string>((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob);
    });
    expect(await readBlob(vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob)).toBe('<title>Safe preview only</title>');
    fireEvent.click(screen.getByRole('button', { name: 'Open in Browser' }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    // Inert FileReader inspection only: this script-bearing export is never navigated to or executed.
    expect(await readBlob(vi.mocked(URL.createObjectURL).mock.calls[1][0] as Blob)).toBe(`${original}<script>/* local Mermaid */</script>`);
    click.mockRestore();
  });
  it('cancels pending preparation on id/session switches and unmount, and revokes only owned URLs', async () => {
    const pending: Array<(html: string) => void> = [];
    vi.mocked(prepareReportPreview).mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    attachment.status = 'ready'; attachment.text = '<p>Original</p>';
    const { rerender, unmount } = render(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={() => {}} />);
    rerender(<HtmlArtifactPanel artifact={{ ...artifact, id: 'report-2' }} sessionId="s1" onClose={() => {}} />);
    await act(async () => pending[0]('<p>Cancelled id</p>'));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    rerender(<HtmlArtifactPanel artifact={{ ...artifact, id: 'report-2' }} sessionId="s2" onClose={() => {}} />);
    await act(async () => pending[1]('<p>Cancelled session</p>'));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await act(async () => pending[2]('<p>Current</p>'));
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    rerender(<HtmlArtifactPanel artifact={artifact} sessionId="s2" onClose={() => {}} />);
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:report');
    expect(screen.queryByRole('button', { name: 'Open in Browser' })).not.toBeInTheDocument();
    unmount();
    await act(async () => pending[3]('<p>Cancelled unmount</p>'));
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });
  it('shows explicit export failure without replacing the ready preview', async () => {
    attachment.status = 'ready'; attachment.text = '<p>Original</p>';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('Download unavailable'); });
    render(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in Browser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Download unavailable');
    expect(screen.getByTitle('Architecture Report')).toHaveAttribute('src', 'blob:report');
    click.mockRestore();
  });
  it('revokes a ready preview on unmount', async () => {
    attachment.status = 'ready'; attachment.text = '<p>Original</p>';
    const { unmount } = render(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Open in Browser' });
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:report');
  });
  it('presents sanitizer failure without a preview or export and ignores cancelled rejection', async () => {
    attachment.status = 'ready'; attachment.text = '<p>Original</p>';
    vi.mocked(prepareReportPreview).mockRejectedValueOnce(new Error('Sanitation unavailable'));
    const { rerender } = render(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={() => {}} />);
    expect(await screen.findByText('Error: Sanitation unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Browser' })).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    let reject!: (error: Error) => void;
    vi.mocked(prepareReportPreview).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    rerender(<HtmlArtifactPanel artifact={{ ...artifact, id: 'report-2' }} sessionId="s1" onClose={() => {}} />);
    rerender(<HtmlArtifactPanel artifact={{ ...artifact, id: 'report-3' }} sessionId="s1" onClose={() => {}} />);
    await act(async () => reject(new Error('Stale error')));
    await screen.findByRole('button', { name: 'Open in Browser' });
    expect(screen.queryByText('Error: Stale error')).not.toBeInTheDocument();
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
  it('K-230: keeps a decomposed (NFD) Japanese report name intact (NFC) on download', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await exportHtmlReport('<title>R</title>', 'レポート-がぎ.html'.normalize('NFD'));
    expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe('レポート-がぎ.html'.normalize('NFC'));
    await exportHtmlReport('<title>R</title>', 'Café re\u0301sume\u0301.html');
    expect((click.mock.instances[1] as HTMLAnchorElement).download).toBe('Café résumé.html'.normalize('NFC'));
    click.mockRestore();
  });
  it('K-235: on iPhone opens the report in a new tab (sandboxed, opaque origin) instead of only downloading', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const tabDocument = document.implementation.createHTMLDocument('');
    const tab = { document: tabDocument, opener: window } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(tab);
    await exportHtmlReport('<title>Original</title><script>run()</script>', 'Quarterly report.html');
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(click).not.toHaveBeenCalled();
    expect(tab.opener).toBeNull();
    expect(tabDocument.title).toBe('Quarterly report.html');
    const frame = tabDocument.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.srcdoc).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
    expect(frame.srcdoc).toContain('<script>run()</script>');
    // No tab (pop-ups blocked, home-screen web app, in-app browser): the
    // download still happens instead of an error.
    open.mockReturnValue(null);
    await expect(exportHtmlReport('<p>x</p>', 'r.html')).resolves.toBeUndefined();
    expect(click).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
  it('K-235: report header buttons get a 44 pt tall touch target on touch screens', () => {
    const css = readFileSync('src/components/chat/chat.css', 'utf8');
    expect(css).toMatch(/@media \(pointer: coarse\) \{[^@]*\.kreport-header button::after \{[^}]*inset: -9px -4px;/);
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
