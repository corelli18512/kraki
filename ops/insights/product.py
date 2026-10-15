"""Read-only account source of truth + per-day active account pseudonyms.
The shared HMAC key never leaves either host. Exports contain no names/emails.
"""
import datetime as dt
import hashlib
import hmac
import sqlite3
from pathlib import Path

DAY = 86400000
OFFSET = 8 * 3600000


def day_bounds(now):
    start = ((int(now) + OFFSET) // DAY) * DAY - OFFSET
    day = dt.datetime.fromtimestamp((start + OFFSET) / 1000, dt.timezone.utc).strftime('%Y-%m-%d')
    return day, start, start + DAY


def account_snapshot(path, key, primary, now):
    if len(key) < 32:
        raise ValueError('a shared 32-byte HMAC key is required')
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
    try:
        db.execute('PRAGMA query_only=ON')
        days = [day_bounds(now - DAY * n) for n in range(3)]
        out = {'primary': primary, 'asOf': now, 'keyId': hashlib.sha256(key).hexdigest()[:16],
               'registration': None, 'activity': {}, 'activityStartedAt': None,
               'coverage': 'foreground reporters only; legacy clients are not counted; open-auth accounts excluded'}
        if primary:
            total = db.execute("SELECT count(*) FROM users WHERE provider <> 'open'").fetchone()[0]
            by_day = {}
            for day, start, end in days:
                by_day[day] = db.execute("SELECT count(*) FROM users WHERE provider <> 'open' AND julianday(created_at)>=julianday(?,'unixepoch') AND julianday(created_at)<julianday(?,'unixepoch')", (start / 1000, end / 1000)).fetchone()[0]
            out['registration'] = {'total': total, 'newByDay': by_day,
                'definition': 'currently retained registered accounts; not lifetime including deleted accounts'}
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_active_users'").fetchone():
            row = db.execute("SELECT value FROM usage_metadata WHERE key='started_at'").fetchone()
            out['activityStartedAt'] = row[0] if row else None
            for day, _, _ in days:
                rows = db.execute("SELECT a.user_id FROM daily_active_users a JOIN users u USING(user_id) WHERE a.day=? AND u.provider<>'open' LIMIT 100001", (day,)).fetchall()
                if len(rows) > 100000: raise ValueError('activity export limit')
                out['activity'][day] = sorted(hmac.new(key, str(row[0]).encode(), hashlib.sha256).hexdigest() for row in rows)
        return out
    finally:
        db.close()


def combine_product(local, peer, now, max_age=180000):
    sources = [s for s in [local, peer] if s]
    fresh = lambda s: isinstance(s.get('asOf'), (int, float)) and 0 <= now - s['asOf'] <= max_age
    authoritative = [s for s in sources if s.get('primary') and fresh(s)]
    registration = authoritative[0]['registration'] if len(authoritative) == 1 else None
    keys_match = len(sources) == 2 and sources[0].get('keyId') == sources[1].get('keyId')
    joined = {}
    for n in range(3):
        day, start, _ = day_bounds(now - DAY * n)
        known = [s for s in sources if fresh(s) and day in s.get('activity', {})]
        # Never quietly report a local count as the global count.
        complete_hosts = keys_match and len(known) == 2
        values = set().union(*(set(s['activity'][day]) for s in known)) if keys_match else set()
        starts = []
        for s in known:
            try: starts.append(dt.datetime.fromisoformat(s['activityStartedAt'].replace('Z', '+00:00')).timestamp() * 1000)
            except (ValueError, TypeError, KeyError, AttributeError): pass
        joined[day] = {'observedDau': len(values) if complete_hosts else None,
                       'hostsComplete': complete_hosts,
                       'dayComplete': complete_hosts and len(starts) == 2 and max(starts) <= start,
                       'coverage': 'new foreground-reporting clients only; not guaranteed full-product DAU'}
    return {'registration': registration, 'days': joined, 'freshHosts': sum(fresh(s) for s in sources),
            'expectedHosts': 2, 'source': 'central account DB + deduplicated foreground activity, never diagnostics samples'}
