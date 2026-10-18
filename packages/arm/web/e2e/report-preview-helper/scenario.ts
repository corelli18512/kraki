import { prepareReportPreview } from '../../src/lib/report-preview';
import { withArtifactCsp } from '../../src/components/chat/HtmlArtifactPanel';

let previous: string | null = null;
Object.assign(window, {
  async renderReport(original: string, baseline: boolean) {
    document.querySelector('iframe')?.remove();
    if (previous) URL.revokeObjectURL(previous);
    const html = baseline ? withArtifactCsp(original) : await prepareReportPreview(original);
    const frame = document.createElement('iframe');
    frame.title = 'Helper preview';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:760px;height:650px;border:0';
    previous = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    frame.src = previous;
    document.body.append(frame);
    return { original, html };
  },
});
