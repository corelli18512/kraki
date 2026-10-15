"""Pure event-time distributions. No latency is inferred from missing samples."""
import collections
import math

# (id, title, latency field, good outcome, P95 limit in ms)
SPECS = {
    'send.summary': ('send', 'Send confirmation', 'confirmMs', 'delivered', 5000),
    'open.summary': ('open', 'Session open', 'viewCurrentMs', 'current', 1500),
    'outage.summary': ('outage', 'Outage impact', 'impactMs', 'recovered', 8000),
    'voice.summary': ('voice', 'Voice release to result', 'finalizeMs', 'final', 4000),
    'ready.summary': ('ready', 'Content ready', 'viewCurrentMs', 'ready', 5000),
    'reply.summary': ('reply', 'Reply first text (observed)', 'firstTextMs', 'completed', None),
}
NON_SERVICE_VOICE = {'permission', 'quota', 'lease_denied_quota_exhausted', 'identity_changed'}


def finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0 <= v <= 86400000


def percentile(values, q):
    if not values:
        return None
    return sorted(values)[max(0, math.ceil(len(values) * q) - 1)]


def eligible(event):
    d, ev = event['d'], event['ev']
    if ev == 'send.summary':
        return d.get('offline') is False and d.get('background') is False and d.get('restored', 0) == 0
    if ev == 'voice.summary':
        return d.get('cause') not in NON_SERVICE_VOICE
    return True


def distributions(events, start, end):
    groups = {}
    excluded = collections.Counter()
    for e in events:
        if not start <= e['t'] < end or e['ev'] not in SPECS:
            continue
        if not eligible(e):
            excluded[e['ev']] += 1
            continue
        ev, d = e['ev'], e['d']
        base, title, field, good, target = SPECS[ev]
        kind = str(d.get('kind', 'all')) if base in ('send', 'ready') else 'all'
        if base == 'voice':
            kind = 'corrected' if d.get('correctionOn') is True else 'raw' if d.get('correctionOn') is False else 'unknown'
        if base == 'ready' and kind == 'warm':
            target = 3000
        if base in ('ready', 'outage'):
            kind += ':' + str(d.get('path', 'unknown'))
        key = '/'.join([base, e['platform'], e['version'], kind])
        g = groups.setdefault(key, dict(id=key, metric=base, title=title, platform=e['platform'], version=e['version'],
            kind=kind, total=0, success=0, failures=0, problems=0, incomplete=0, cancelled=0, stalls=0,
            values=[], devices=set(), observedReplies=0, targetMs=target, latestEventAt=0))
        g['total'] += 1
        g['devices'].add(e['owner'])
        g['latestEventAt'] = max(g['latestEventAt'], e['t'])
        outcome = d.get('outcome')
        if outcome == good:
            g['success'] += 1
            if finite(d.get(field)):
                g['values'].append(d[field])
        elif outcome in ('failed', 'timeout', 'abandoned'):
            g['failures'] += 1
        elif outcome in ('cancelled', 'deleted', 'cleared', 'left', 'departed', 'stopped', 'superseded'):
            g['cancelled'] += 1
        else:
            g['incomplete'] += 1
        if base == 'send' and d.get('shown') in ('failed', 'unconfirmed'):
            g['problems'] += 1
        if base == 'reply' and d.get('deltas', 0) >= 2:
            g['observedReplies'] += 1
            if d.get('stalls', 0) > 0: g['stalls'] += 1
    out = []
    for g in groups.values():
        values = g.pop('values')
        g['devices'] = len(g['devices'])
        g['stallRate'] = g['stalls'] / g['observedReplies'] if g['observedReplies'] else None
        g.update(samples=len(values), p50Ms=percentile(values, .50), p95Ms=percentile(values, .95), p99Ms=percentile(values, .99))
        g['extreme'] = sum(v > max(15000, (g['targetMs'] or 0) * 3) for v in values) if g['targetMs'] else 0
        denominator = g['success'] + g['failures']
        g['failureRate'] = g['failures'] / denominator if denominator else None
        g['problemRate'] = g['problems'] / g['total'] if g['total'] else None
        out.append(g)
    return sorted(out, key=lambda g: g['id']), dict(excluded)


def pending_sends(events, start, end):
    """Raw lifecycle closes the successful-summary survivor bias. Only matched
    typed input creation + explicit failed state, not silence alone, is a failure.
    A partial/delayed upload is labeled unresolved, never presumed lost."""
    created, closed, failed = {}, set(), set()
    for e in events:
        d = e['d']
        cid = d.get('clientId')
        if not isinstance(cid, str) or not cid:
            continue
        key = (e['owner'], cid)
        if e['ev'] == 'cmd.input' and start <= e['t'] < end:
            created[key] = min(created.get(key, e['t']), e['t'])
        if e['ev'] == 'echo.input' and d.get('matched') is True:
            closed.add(key)
        if e['ev'] == 'outbox.state':
            if d.get('phase') == 'failed': failed.add(key)
            if d.get('phase') == 'cleared': closed.add(key)
    unresolved = [key for key, t in created.items() if key not in closed and end - t > 120000]
    return {'created': len(created), 'unresolved': len(unresolved), 'explicitFailures': sum(k in failed for k in unresolved),
            'coverage': 'observed lifecycle only; unresolved does not prove delivery failure'}
