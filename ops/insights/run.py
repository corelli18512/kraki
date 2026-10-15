#!/usr/bin/env python3
"""Independent, bounded insights job. No Head restart/migration/write access.
Config is a root-owned JSON file; secrets are referenced by path, never logged.
"""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from indexer import Index
from metrics import distributions, pending_sends
from product import DAY, account_snapshot, combine_product, day_bounds


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.insights-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, ensure_ascii=False, allow_nan=False)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def peer_snapshot(config):
    peer = config.get('peer')
    if not peer: return None
    try:
        # Ignore ambient SSH configuration/agents/multiplexed admin sessions:
        # this must authenticate with the dedicated forced-command key.
        result = subprocess.run(['ssh', '-F', '/dev/null', '-T', '-i', peer['keyFile'],
            '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'IdentityAgent=none',
            '-o', 'ClearAllForwardings=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'UserKnownHostsFile=' + peer['knownHostsFile'], peer['destination'], 'export'],
            capture_output=True, timeout=8, check=True)
        if len(result.stdout) > 16 * 1024 * 1024: return None
        value = json.loads(result.stdout)
        if value.get('schema') != 1 or value.get('host') != peer['host']: return None
        return value
    except (OSError, ValueError, subprocess.SubprocessError):
        return None  # Freshness/host coverage explicitly degrades, not a cached zero.


def build(config, state_dir, now, *, clock=time.monotonic):
    started = clock()
    index = Index(state_dir / 'index.sqlite')
    try:
        scan = index.ingest(config['diagDirectory'], now)
        yesterday, start, end = day_bounds(now - DAY)
        prior_day, prior_start, _ = day_bounds(now - 2 * DAY)
        events = index.events(prior_start, now)
        recent, excluded = distributions(events, now - 15 * 60000, now)
        daily, day_excluded = distributions(events, start, end)
        previous, _ = distributions(events, prior_start, start)
        late = sum(now - e['t'] > 15 * 60000 and e['receivedAt'] >= now - 15 * 60000 for e in events)
        product = account_snapshot(config['headDb'], Path(config['hmacKeyFile']).read_bytes(), config.get('primary') is True, now)
        snapshot = dict(schema=1, host=config['host'], asOf=now, product=product, recent=recent,
            daily={'date': yesterday, 'start': start, 'end': end, 'metrics': daily, 'excluded': day_excluded},
            previous={'date': prior_day, 'metrics': previous},
            pending=pending_sends(events, now - 15 * 60000, now),
            quality=dict(scan=scan, lateArrivals=late, excluded=excluded,
                latestEventAt=max((e['t'] for e in events), default=None),
                latestReceivedAt=max((e['receivedAt'] for e in events), default=None),
                collectionDisabled=(Path(config['diagDirectory']) / 'DISABLED').exists(),
                coverage='optional native iOS/Mac diagnostics; uploads can be delayed; web/windows not covered'))
        atomic_json(state_dir / 'export.json', snapshot)
        peer = peer_snapshot(config)
        # No per-account pseudonym sets go into watch state or notifications.
        summary = {k: v for k, v in snapshot.items() if k != 'product'}
        if config.get('primary'):
            checked_at = now + (clock() - started) * 1000
            summary['product'] = combine_product(product, peer.get('product') if peer else None, now, checked_at=checked_at)
        atomic_json(state_dir / 'summary.json', summary)
        return snapshot
    finally:
        index.close()


def main():
    config = json.loads(Path(os.environ.get('KRAKI_INSIGHTS_CONFIG', '/etc/kraki/insights.json')).read_text())
    state_dir = Path(config.get('stateDirectory', '/var/lib/kraki-insights'))
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.umask(0o077)
    with (state_dir / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        snapshot = build(config, state_dir, time.time() * 1000)
    print('insights ok:', config['host'], 'imported', snapshot['quality']['scan']['imported'],
          'recent cohorts', len(snapshot['recent']), 'backlog', snapshot['quality']['scan']['backlog'])


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Database errors can contain paths or data. The stale-output check
        # alerts; detailed investigation is explicit, not logged automatically.
        print('insights failed; summary was not refreshed', file=sys.stderr)
        sys.exit(1)
