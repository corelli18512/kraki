#!/usr/bin/env python3
"""Stability report from client diagnostics (manual tool, never CI).

Reads the summaries the native apps send (ready / outage / open / send / voice
.summary, see docs/stability-metrics.md) and writes one HTML page.

  # pull the collector data from a Head host over ssh, then report
  python3 scripts/diag/stability-report.py --pull corelli-tecent-cloud-small-0 --out /tmp/stability
  # or report on an existing copy of /var/lib/kraki-diag
  python3 scripts/diag/stability-report.py --dir ~/diag-copy --out /tmp/stability
  # optional: add reconnect storms seen by the Head (journalctl -u kraki-relay)
  ... --head-log head.log

Options: --since YYYY-MM-DD  --platform ios|mac
Output stays local; it contains metadata only (no message content exists in it).
"""
import argparse
import collections
import datetime as dt
import glob
import gzip
import html
import json
import os
import re
import subprocess
import sys

TARGETS = {  # p95 targets (ms), see docs/stability-metrics.md
    ('warm', 'viewCurrentMs'): 3000, ('cold', 'viewCurrentMs'): 5000, ('wake', 'viewCurrentMs'): 5000,
    ('warm', 'authedMs'): 2000, ('cold', 'authedMs'): 3000, ('wake', 'authedMs'): 3000,
}
SUMMARIES = {'ready.summary', 'outage.summary', 'open.summary', 'send.summary', 'voice.summary'}


def pct(values, p):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    return values[min(len(values) - 1, int(p / 100 * len(values)))]


def fmt_ms(v):
    if v is None:
        return '–'
    return f'{v / 1000:.1f} s' if v >= 1000 else f'{v:.0f} ms'


def load(directory, since, platform):
    events = []
    for path in glob.glob(os.path.join(directory, '**', '*.json.gz'), recursive=True):
        try:
            batch = json.load(gzip.open(path))
        except (OSError, ValueError):
            continue
        if platform and batch.get('platform') != platform:
            continue
        device = os.path.basename(os.path.dirname(path))[:8]
        for e in batch.get('events', []):
            if e.get('ev') not in SUMMARIES:
                continue
            when = dt.datetime.fromtimestamp(e['t'] / 1000)
            if since and when < since:
                continue
            events.append({**e['d'], 'ev': e['ev'], 'when': when, 'platform': batch.get('platform'),
                           'version': f"{batch.get('version')}({batch.get('build')})", 'device': device})
    events.sort(key=lambda e: e['when'])
    return events


def head_storms(path):
    """Devices with >=3 authentications within 2 minutes (reconnect storms)."""
    per = collections.defaultdict(list)
    for line in open(path, errors='replace'):
        m = re.search(r'\[(\S+Z)\] Device authenticated[^{]*(\{.*\})', line)
        if not m:
            continue
        try:
            device = json.loads(m.group(2)).get('deviceId')
        except ValueError:
            continue
        per[device].append(dt.datetime.fromisoformat(m.group(1).replace('Z', '+00:00')).astimezone())
    storms = []
    for device, ts in per.items():
        i = 0
        while i < len(ts):
            j = i
            while j + 1 < len(ts) and (ts[j + 1] - ts[j]).total_seconds() < 120:
                j += 1
            if j - i >= 2:
                storms.append((ts[i], device, j - i + 1, (ts[j] - ts[i]).total_seconds()))
            i = j + 1
    return sorted(storms)


def table(headers, rows):
    out = ['<table><tr>' + ''.join(f'<th>{html.escape(h)}</th>' for h in headers) + '</tr>']
    for row in rows:
        out.append('<tr>' + ''.join(f'<td>{c}</td>' for c in row) + '</tr>')
    return '\n'.join(out) + '</table>'


def flag(value, target):
    text = fmt_ms(value)
    return f'<b class="bad">{text}</b>' if value is not None and target and value > target else text


def dist(values):
    return ', '.join(f'{html.escape(str(k))} {v}' for k, v in collections.Counter(values).most_common()) or '–'


def report(events, storms):
    parts = []
    by = collections.defaultdict(list)
    for e in events:
        by[e['ev']].append(e)

    # Openings
    ready = by['ready.summary']
    rows = []
    for (plat, kind), group in sorted(collections.defaultdict(list, {
            k: [e for e in ready if (e['platform'], e['kind']) == k]
            for k in {(e['platform'], e['kind']) for e in ready}}).items()):
        vc = [e.get('viewCurrentMs') for e in group if e.get('outcome') == 'ready']
        au = [e.get('authedMs') for e in group]
        rows.append([plat, kind, len(group), dist(e['outcome'] for e in group),
                     fmt_ms(pct(au, 50)), flag(pct(au, 95), TARGETS.get((kind, 'authedMs'))),
                     fmt_ms(pct(vc, 50)), flag(pct(vc, 95), TARGETS.get((kind, 'viewCurrentMs'))),
                     sum(1 for e in group if e.get('attempt', 0) > 0),
                     sum(1 for e in group if e.get('previousExit') == 'unclean')])
    parts.append('<h2>打开 App → 看到最新消息</h2>' + table(
        ['平台', '类型', '次数', '结果', '认证 p50', '认证 p95', '看到最新 p50', '看到最新 p95', '有失败重试', '上次非正常退出'], rows))
    slow = [e for e in ready if e.get('outcome') != 'ready'
            or (e.get('viewCurrentMs') or 0) > TARGETS.get((e['kind'], 'viewCurrentMs'), 1e12)]
    if slow:
        parts.append('<h3>慢或未完成的打开</h3>' + table(
            ['时间', '平台', '类型', '结果', '后台时长', '连上', '认证', '列表', '看到最新', '重试', '缺消息', '网络'],
            [[e['when'].strftime('%m-%d %H:%M:%S'), e['platform'], e['kind'], e['outcome'], fmt_ms(e.get('backgroundMs')),
              fmt_ms(e.get('wsOpenMs')), fmt_ms(e.get('authedMs')), fmt_ms(e.get('listFreshMs')),
              fmt_ms(e.get('viewCurrentMs')), e.get('attempt', 0), e.get('gap', 0), e.get('path')] for e in slow[-40:]]))

    # Outages
    outages = by['outage.summary']
    parts.append('<h2>断线（前台）</h2>')
    if outages:
        rows = []
        for plat in sorted({e['platform'] for e in outages}):
            group = [e for e in outages if e['platform'] == plat]
            rows.append([plat, len(group), dist(e.get('source') for e in group), dist(e.get('outcome') for e in group),
                         fmt_ms(pct([e.get('impactMs') for e in group], 50)), flag(pct([e.get('impactMs') for e in group], 95), 8000),
                         fmt_ms(pct([e.get('detectMs') for e in group], 95)),
                         sum(1 for e in group if e.get('visibleMs', 0) > 0),
                         sum(1 for e in group if e.get('pathChanged')), sum(1 for e in group if e.get('afterWake'))])
        parts.append(table(['平台', '次数', '原因', '结果', '影响 p50', '影响 p95', '发现 p95', '显示了重连中', '网络切换', '唤醒后'], rows))
        parts.append('<h3>每次断线</h3>' + table(
            ['时间', '平台', '原因', '码', '结果', '发现', '重连', '补齐', '影响', '显示重连中', '重试', '网络'],
            [[e['when'].strftime('%m-%d %H:%M:%S'), e['platform'], e.get('source'), e.get('code', ''), e.get('outcome'),
              fmt_ms(e.get('detectMs')), fmt_ms(e.get('reconnectMs')), fmt_ms(e.get('catchupMs')),
              flag(e.get('impactMs'), 8000), fmt_ms(e.get('visibleMs')), e.get('attempt', 0),
              e.get('path', '') + (' (切换)' if e.get('pathChanged') else '') + (' 唤醒后' if e.get('afterWake') else '')]
             for e in outages[-60:]]))
        bursts = []
        for plat in {e['platform'] for e in outages}:
            ts = [e['when'] for e in outages if e['platform'] == plat]
            for i in range(len(ts) - 2):
                if (ts[i + 2] - ts[i]).total_seconds() <= 120:
                    bursts.append(f'{plat} {ts[i]:%m-%d %H:%M}')
        if bursts:
            parts.append('<p class="bad">客户端侧风暴（2 分钟内 ≥3 次断线）：' + html.escape(', '.join(sorted(set(bursts)))) + '</p>')
    else:
        parts.append('<p>没有前台断线记录。</p>')
    if storms is not None:
        parts.append('<h3>服务器侧重连风暴（Head 日志：2 分钟内 ≥3 次认证）</h3>' + (table(
            ['开始', '设备', '次数', '持续'], [[t.strftime('%m-%d %H:%M:%S'), d, n, f'{s:.0f} s'] for t, d, n, s in storms[-60:]])
            if storms else '<p>无。</p>'))

    # Sending
    sends = by['send.summary']
    parts.append('<h2>发消息</h2>')
    if sends:
        rows = []
        for (plat, kind) in sorted({(e['platform'], e['kind']) for e in sends}):
            group = [e for e in sends if (e['platform'], e['kind']) == (plat, kind)]
            shown = [e for e in group if e.get('shown') != 'none']
            rows.append([plat, kind, len(group), dist(e.get('outcome') for e in group),
                         fmt_ms(pct([e.get('confirmMs') for e in group], 50)), flag(pct([e.get('confirmMs') for e in group], 95), 5000),
                         f'{len(shown)} ({len(shown) / len(group):.0%})',
                         sum(1 for e in shown if e.get('outcome') == 'delivered' and e.get('manualRetries', 0) == 0),
                         dist(e.get('cause') for e in shown), sum(e.get('manualRetries', 0) for e in group),
                         sum(e.get('autoResends', 0) for e in group),
                         fmt_ms(pct([e.get('correctionMs') for e in group], 95)) if kind == 'voice' else '–'])
        parts.append(table(['平台', '类型', '条数', '结果', '确认 p50', '确认 p95', '显示过问题', '其中误报', '问题原因',
                            '手动重试', '自动补发', '语音整理 p95'], rows))
        bad = [e for e in sends if e.get('shown') != 'none' or e.get('outcome') != 'delivered']
        if bad:
            parts.append('<h3>显示过问题或没送达的消息</h3>' + table(
                ['时间', '平台', '类型', '结果', '显示', '显示时长', '原因', '后台', '手动', '自动', '重启恢复', '离线发送', '确认'],
                [[e['when'].strftime('%m-%d %H:%M:%S'), e['platform'], e['kind'], e.get('outcome'), e.get('shown'),
                  fmt_ms(e.get('shownMs')), e.get('cause', ''), '是' if e.get('background') else '',
                  e.get('manualRetries', 0), e.get('autoResends', 0), '是' if e.get('restored') else '',
                  '是' if e.get('offline') else '', fmt_ms(e.get('confirmMs'))] for e in bad[-60:]]))
    else:
        parts.append('<p>没有记录。</p>')

    # Voice
    voice = by['voice.summary']
    parts.append('<h2>语音</h2>')
    if voice:
        rows = []
        for plat in sorted({e['platform'] for e in voice}):
            group = [e for e in voice if e['platform'] == plat]
            failed = [e for e in group if e.get('outcome') == 'failed']
            finals = [e for e in group if e.get('outcome') == 'final']
            rows.append([plat, len(group), dist(e.get('outcome') for e in group),
                         f'{len(failed)} ({len(failed) / len(group):.0%})',
                         dist(f"{e.get('stage')}/{e.get('cause', '?')}" for e in failed),
                         fmt_ms(pct([e.get('startMs') for e in group], 95)),
                         fmt_ms(pct([e.get('finalizeMs') for e in finals], 50)), flag(pct([e.get('finalizeMs') for e in finals], 95), 4000),
                         sum(1 for e in finals if not e.get('confirmed') and e.get('correctionOn', True)),
                         sum(1 for e in group if e.get('correctionOn') is False)])
        parts.append(table(['平台', '次数', '结果', '失败', '失败阶段/原因', '按下→开录 p95', '松手→结果 p50',
                            '松手→结果 p95', '纠错未确认', '纠错已关闭'], rows))
        problems = [e for e in voice if e.get('outcome') in ('failed', 'suspended') or e.get('cause')]
        if problems:
            parts.append('<h3>语音问题</h3>' + table(
                ['时间', '平台', '结果', '阶段', '原因', '连接已预热', '录音', '收尾'],
                [[e['when'].strftime('%m-%d %H:%M:%S'), e['platform'], e.get('outcome'), e.get('stage'), e.get('cause', ''),
                  '是' if e.get('warm') else '否', fmt_ms(e.get('recordMs')), fmt_ms(e.get('finalizeMs'))] for e in problems[-60:]]))
    else:
        parts.append('<p>没有记录。</p>')

    # Conversation opens
    opens = by['open.summary']
    if opens:
        vc = [e.get('viewCurrentMs') for e in opens if e.get('outcome') == 'current']
        parts.append('<h2>点开会话 → 看到最新</h2>' + table(
            ['次数', '结果', '看到最新 p50', 'p95', '需要补拉的比例'],
            [[len(opens), dist(e.get('outcome') for e in opens), fmt_ms(pct(vc, 50)), flag(pct(vc, 95), 1500),
              f"{sum(1 for e in opens if e.get('gap', 0) > 0) / len(opens):.0%}"]]))

    versions = dist(f"{e['platform']} {e['version']}" for e in events)
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Kraki 稳定性报告</title>
<style>body{{font:14px/1.55 -apple-system,system-ui,sans-serif;max-width:1100px;margin:20px auto;padding:0 16px;color:#1d2330}}
table{{border-collapse:collapse;margin:8px 0 18px;font-size:13px}}th,td{{border:1px solid #dde1e8;padding:4px 7px;text-align:left}}
th{{background:#f4f6f9}}.bad{{color:#c0262d}}h2{{margin-top:28px;border-bottom:1px solid #e3e6ec}}</style></head><body>
<h1>Kraki 稳定性报告</h1><p>{len(events)} 条汇总记录；版本：{versions}；生成于 {dt.datetime.now():%Y-%m-%d %H:%M}。
红色 = 超出目标（docs/stability-metrics.md）。</p>{''.join(parts)}</body></html>"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dir', help='local copy of the collector directory')
    ap.add_argument('--pull', metavar='SSH_HOST', help='copy /var/lib/kraki-diag from this host first')
    ap.add_argument('--head-log', help='Head journal text for server-side storm detection')
    ap.add_argument('--since', help='YYYY-MM-DD')
    ap.add_argument('--platform', choices=['ios', 'mac'])
    ap.add_argument('--out', default='/tmp/kraki-stability')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    directory = args.dir
    if args.pull:
        directory = os.path.join(args.out, 'batches')
        os.makedirs(directory, exist_ok=True)
        tar = subprocess.run(['ssh', args.pull, 'sudo tar -C /var/lib/kraki-diag -czf - .'], capture_output=True, check=True).stdout
        subprocess.run(['tar', '-C', directory, '-xzf', '-'], input=tar, check=True)
    if not directory:
        ap.error('--dir or --pull is required')
    since = dt.datetime.fromisoformat(args.since) if args.since else None
    events = load(directory, since, args.platform)
    storms = head_storms(args.head_log) if args.head_log else None
    path = os.path.join(args.out, 'stability-report.html')
    with open(path, 'w') as f:
        f.write(report(events, storms))
    print(f'{len(events)} summaries → {path}')


if __name__ == '__main__':
    sys.exit(main())
