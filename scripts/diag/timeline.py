#!/usr/bin/env python3
"""Offline metadata timeline. Reads local/downloaded batches; never contacts Head.
Cross-process wall times are approximate. Durations only use one process's m clock.
"""
import argparse
import gzip
import json
from pathlib import Path


def load(path):
    rows, seen = [], set()
    files = [path] if path.is_file() else sorted(path.rglob('*.gz'))
    for file in files:
        try:
            with gzip.open(file, 'rt') as source:
                batch = json.load(source)
            if batch.get('schema') != 1:
                continue
            for event in batch['events']:
                key = (batch['processId'], event['seq'])
                if key in seen:
                    continue
                seen.add(key)
                rows.append({**event, 'process': batch['processId'], 'platform': batch['platform'], 'image': batch.get('image')})
        except (OSError, ValueError, KeyError) as error:
            raise SystemExit(f'Invalid batch {file}: {type(error).__name__}') from error
    return rows


def select(rows, question=None, client=None, session=None):
    clients = {client} if client else set()
    if question:
        clients.update(e['d']['clientId'] for e in rows if e['d'].get('answerTo') == question and 'clientId' in e['d'])
    return [e for e in rows if (not session or e.get('sid') == session)
            and (not (question or client) or e['d'].get('questionId') == question and question is not None
                 or e['d'].get('answerTo') == question and question is not None or e['d'].get('clientId') in clients)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path', type=Path)
    parser.add_argument('--question')
    parser.add_argument('--client-id')
    parser.add_argument('--session')
    args = parser.parse_args()
    rows = select(load(args.path), args.question, args.client_id, args.session)
    processes = sorted({e['process'] for e in rows})
    for process in processes:
        events = sorted((e for e in rows if e['process'] == process), key=lambda e: e['seq'])
        if not events:
            continue
        print(f'\nprocess={process} platform={events[0]["platform"]} image={json.dumps(events[0]["image"])}')
        baseline = events[0]['m']
        for e in events:
            print(f'{e["seq"]:6} +{e["m"] - baseline:10.2f}ms {e["ev"]:16} sid={e.get("sid", "-")} {json.dumps(e["d"], sort_keys=True)}')
    print(f'\n{len(rows)} unique events / {len(processes)} processes. No cross-process latency inference.')


if __name__ == '__main__':
    main()
