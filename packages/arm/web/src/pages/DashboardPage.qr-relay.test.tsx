import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useStore } from '../hooks/useStore';

vi.mock('../lib/ws-client', () => ({
  wsClient: { pairWithToken: vi.fn(), url: 'wss://relay.kraki.chat' },
}));
// The camera is not available here: the scanner reports the code it "saw".
let scanned = '';
vi.mock('../components/common/QrScanner', () => ({
  QrScanner: ({ onScan }: { onScan: (url: string) => void }) => (
    <button type="button" onClick={() => onScan(scanned)}>fake-scan</button>
  ),
}));

import { wsClient } from '../lib/ws-client';
import { DashboardPage } from './DashboardPage';

function scan(url: string) {
  scanned = url;
  render(<MemoryRouter><DashboardPage /></MemoryRouter>);
  fireEvent.click(screen.getByText('Scan QR Code'));
  fireEvent.click(screen.getByText('fake-scan'));
}

// K-003: the in-app scanner confirms a self-hosted relay like a pairing link does.
describe('DashboardPage QR scanner relay confirmation', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.getState().reset();
    useStore.getState().setStatus('awaiting_login');
    vi.clearAllMocks();
  });

  it('pairs with a Kraki relay straight away', () => {
    scan('https://app.kraki.chat/?relay=wss://relay.kraki.chat&token=pt_1');
    expect(wsClient.pairWithToken).toHaveBeenCalledWith('wss://relay.kraki.chat', 'pt_1');
  });

  it('asks before pairing with a self-hosted relay, and pairs only after Connect', () => {
    scan('https://app.kraki.chat/?relay=wss://evil.example:4000&token=pt_1');
    expect(wsClient.pairWithToken).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Connect to a self-hosted server?' });
    expect(dialog).toHaveTextContent('evil.example:4000');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(wsClient.pairWithToken).toHaveBeenCalledWith('wss://evil.example:4000', 'pt_1');
  });

  it('does not pair when the user cancels', () => {
    scan('https://app.kraki.chat/?relay=wss://evil.example&token=pt_1');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(wsClient.pairWithToken).not.toHaveBeenCalled();
  });
});
