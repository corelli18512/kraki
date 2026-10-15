"""Incremental read-only diagnostics reader; its only writes are to its own index.
Source paths are opaque owner/batch IDs. Never reads conversation databases.
"""
import gzip
import json
import math
import re
import sqlite3
import time
from pathlib import Path

EVENTS = {'send.summary', 'voice.summary', 'ready.summary', 'open.summary', 'outage.summary', 'reply.summary',
          'cmd.input', 'echo.input', 'outbox.state'}
FIELDS = {'kind', 'outcome', 'path', 'offline', 'background', 'restored', 'shown', 'cause', 'stage',
          'confirmMs', 'viewCurrentMs', 'impactMs', 'finalizeMs', 'firstTextMs', 'deltas', 'stalls',
          'correctionOn', 'clientId', 'phase', 'matched'}
RETENTION = 14 * 86400000


class Index:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.executescript('''
          PRAGMA journal_mode=WAL;
          PRAGMA busy_timeout=1000;
          CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, stamp TEXT NOT NULL, received REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS events(
            owner TEXT NOT NULL, process TEXT NOT NULL, seq INTEGER NOT NULL,
            at REAL NOT NULL, received REAL NOT NULL, platform TEXT NOT NULL, version TEXT NOT NULL,
            event TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,process,seq));
          CREATE INDEX IF NOT EXISTS events_time ON events(at);
        ''')

    def close(self):
        self.db.close()

    def ingest(self, directory, now, max_files=1000, budget_seconds=15):
        result = dict(scanned=0, imported=0, duplicates=0, invalid=0, old=0, future=0, backlog=False)
        started = time.monotonic()
        base = Path(directory)
        if not base.is_dir():
            raise RuntimeError('diagnostic directory missing')
        for owner in sorted(base.iterdir()):
            if owner.is_symlink() or not owner.is_dir() or not re.fullmatch('[a-f0-9]{64}', owner.name):
                continue
            for file in sorted(owner.iterdir()):
                if file.is_symlink() or not file.is_file() or not re.fullmatch('[a-f0-9-]+[.]json[.]gz', file.name):
                    continue
                stat = file.stat()
                path, stamp = owner.name + '/' + file.name, f'{stat.st_mtime_ns}:{stat.st_size}'
                seen = self.db.execute('SELECT stamp FROM files WHERE path=?', (path,)).fetchone()
                if seen and seen[0] == stamp:
                    continue
                if result['scanned'] >= max_files or time.monotonic() - started > budget_seconds:
                    result['backlog'] = True
                    break
                result['scanned'] += 1
                received = stat.st_mtime * 1000
                try:
                    if stat.st_size > 65536: raise ValueError('compressed limit')
                    with gzip.open(file, 'rb') as source:
                        raw = source.read(262145)
                    if len(raw) > 262144: raise ValueError('raw limit')
                    batch = json.loads(raw)
                    process = batch['processId']
                    platform = batch['platform']
                    version = str(batch['version']) + '(' + str(batch['build']) + ')'
                    if platform not in ('ios', 'mac'):  # Explicitly exclude local test-platform batches.
                        continue
                    if not re.fullmatch(r'[a-fA-F0-9-]{36}', process) or not re.fullmatch(r'[0-9.]{1,32}\([0-9]{1,16}\)', version):
                        raise ValueError('identity shape')
                    events = batch['events']
                    if not isinstance(events, list) or len(events) > 1000: raise ValueError('events limit')
                    for e in events:
                        if e.get('ev') not in EVENTS: continue
                        at, seq, data = e.get('t'), e.get('seq'), e.get('d')
                        if (not isinstance(at, (int, float)) or isinstance(at, bool) or not math.isfinite(at) or at < 0 or not isinstance(seq, int)
                                or isinstance(seq, bool) or seq < 1 or not isinstance(data, dict)):
                            result['invalid'] += 1; continue
                        if at < now - RETENTION: result['old'] += 1; continue
                        # Event timestamps are client wall time; reject implausible clocks.
                        if at > min(now, received) + 120000: result['future'] += 1; continue
                        compact = {k: v for k, v in data.items() if k in FIELDS}
                        changed = self.db.execute('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?,?,?)',
                            (owner.name, process, seq, at, received, platform, version, e['ev'], json.dumps(compact))).rowcount
                        result['imported' if changed else 'duplicates'] += 1
                except (OSError, ValueError, KeyError, TypeError):
                    result['invalid'] += 1
                finally:
                    self.db.execute('INSERT OR REPLACE INTO files VALUES(?,?,?)', (path, stamp, received))
                self.db.commit()
            if result['backlog']: break
        self.db.execute('DELETE FROM events WHERE at < ?', (now - RETENTION,))
        # Keep dedup file records while source files are retained by the collector.
        self.db.execute('DELETE FROM files WHERE received < ?', (now - RETENTION - 86400000,))
        self.db.commit()
        return result

    def events(self, start, end):
        rows = self.db.execute('SELECT owner,at,received,platform,version,event,data FROM events WHERE at>=? AND at<? ORDER BY at LIMIT 500001', (start, end)).fetchall()
        if len(rows) > 500000: raise ValueError('event query limit; do not report truncated percentiles')
        return [dict(owner=r[0], t=r[1], receivedAt=r[2], platform=r[3], version=r[4], ev=r[5], d=json.loads(r[6])) for r in rows]
