#!/usr/bin/env python3
"""Drive a local-only Mac Dev's actual effort picker and verify the round trip.

No launch/kill/focus actions. Requires session-effort.ts plus an already-running
visible Mac Dev (off-screen SwiftUI sheets may not materialize native controls).
Use --remote-ios during SessionEffortE2EUITests to edit while its card is visible.
"""
import argparse
import json
import socket
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--state-dir', required=True, type=Path)
    parser.add_argument('--remote-ios', action='store_true')
    args = parser.parse_args()
    root = args.state_dir.resolve()
    ready = json.loads((root / 'ready.json').read_text())
    sid, model = ready['sessionId'], ready['model']

    def call(method, params=None):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(15)
            client.connect(args.socket)
            client.sendall((json.dumps({'id': method, 'method': method, 'params': params or {}}) + '\n').encode())
            response = json.loads(client.makefile().readline())
        if not response.get('ok'):
            raise RuntimeError(response)
        return response['result']

    snapshot = call('snapshot')
    assert snapshot['relayURL'] in [f'ws://localhost:{ready["port"]}', f'ws://127.0.0.1:{ready["port"]}'], 'LOCAL relay only'
    if args.remote_ios:
        deadline = time.monotonic() + 180
        while not (root / 'ios-awaiting-remote-low').exists():
            if time.monotonic() > deadline:
                raise TimeoutError('No iOS ready marker')
            time.sleep(.25)
        levels = ['low']
    else:
        call('selectSession', {'sessionId': sid})
        time.sleep(1)
        call('presentSessionInfo')
        time.sleep(1)
        levels = ['low', 'high']

    for level in levels:
        before = len(json.loads((root / 'state.json').read_text())['acknowledgements'])
        assert call('chooseReasoningEffort', {'effort': level})['dispatched']
        deadline = time.monotonic() + 30
        while True:
            snapshot = call('snapshot')
            session = next(s for s in snapshot['sessions'] if s['id'] == sid)
            server = json.loads((root / 'state.json').read_text())
            new_acks = server['acknowledgements'][before:]
            if (session.get('cardEffortLabel') == level and session['model'] == model
                    and server['runtime']['thinking'] == level and server['runtime']['model'] == model
                    and any(a['payload'].get('reasoningEffort') == level for a in new_acks)):
                break
            if time.monotonic() > deadline:
                raise TimeoutError(f'{level} did not round-trip: {session}, {server}')
            time.sleep(.25)
        prefix = f'mac-{"remote-" if args.remote_ios else ""}{level}'
        (root / f'{prefix}-verified.json').write_text(json.dumps({'client': snapshot, 'server': server}, indent=2))
        time.sleep(.5)
        call('captureSidebar', {'path': str(root / f'{prefix}-card.png')})
        call('capture', {'path': str(root / f'{prefix}-picker.png'), 'sheetOnly': True})
        print(f'PASS: model unchanged ({model}), picker -> ack -> card/runtime = {level}', flush=True)


if __name__ == '__main__':
    main()
