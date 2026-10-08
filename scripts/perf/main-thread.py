#!/usr/bin/env python3
"""Main-thread stalls in a Time Profiler trace (manual tool).

  python3 scripts/perf/main-thread.py TRACE PID [--min-ms 50] [--app Kraki] [--top 25]

Exports the time-profile table, keeps the main thread of PID, groups samples
into busy stretches (gap < 3 ms), and for stretches >= --min-ms reports:
  - per stretch: duration and the deepest app frames that cover most samples
  - overall: app frames by inclusive main-thread time inside stalls
App frames = frames whose binary name contains --app (default Kraki).
"""
import argparse
import collections
import subprocess
import xml.etree.ElementTree as ET


def export(trace):
    xml = subprocess.check_output([
        'xcrun', 'xctrace', 'export', '--input', trace, '--xpath',
        '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'])
    return ET.fromstring(xml)


def samples(root, pid):
    ids = {}
    out = []
    for el in root.iter():
        if 'id' in el.attrib:
            ids[el.attrib['id']] = el
    def res(e):
        return ids[e.attrib['ref']] if e is not None and 'ref' in e.attrib else e
    for row in root.iter('row'):
        thread = res(row.find('thread'))
        if thread is None:
            continue
        fmt = thread.attrib.get('fmt', '')
        if f'pid: {pid})' not in fmt or not fmt.startswith('Main Thread'):
            continue
        t = int(res(row.find('sample-time')).text)
        bt = res(row.find('tagged-backtrace'))
        frames = []
        if bt is not None:
            b = bt.find('backtrace')
            b = res(b) if b is not None else None
            if b is not None:
                for f in b.findall('frame'):
                    f = res(f)
                    binary = f.find('binary')
                    binary = res(binary) if binary is not None else None
                    frames.append((f.attrib.get('name', '?'), binary.attrib.get('name', '') if binary is not None else ''))
        out.append((t, frames))
    out.sort(key=lambda s: s[0])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('trace'); ap.add_argument('pid')
    ap.add_argument('--min-ms', type=float, default=50); ap.add_argument('--app', default='Kraki')
    ap.add_argument('--top', type=int, default=25)
    ap.add_argument('--focus', action='append', default=[], help='show callees of this frame (substring)')
    ap.add_argument('--all', action='store_true', help='all busy samples, not only stalls')
    a = ap.parse_args()
    s = samples(export(a.trace), a.pid)
    if not s:
        print('no main-thread samples for pid', a.pid); return
    # Idle main thread sits in mach_msg; treat those samples as not busy.
    def busy(frames):
        return frames and frames[0][0] not in ('mach_msg2_trap', 'mach_msg_trap', '__psynch_cvwait', 'kevent_id')
    stretches, cur = [], []
    for t, fr in s:
        if not busy(fr):
            if cur: stretches.append(cur); cur = []
            continue
        if cur and t - cur[-1][0] > 3_000_000:
            stretches.append(cur); cur = []
        cur.append((t, fr))
    if cur: stretches.append(cur)
    total_busy = sum(len(x) for x in stretches)
    long = [x for x in stretches if (x[-1][0] - x[0][0]) / 1e6 + 1 >= a.min_ms]
    print(f'main-thread samples={len(s)} busy={total_busy} ms; stalls >= {a.min_ms:.0f} ms: {len(long)}')
    incl = collections.Counter()
    for x in long:
        dur = (x[-1][0] - x[0][0]) / 1e6 + 1
        seen_per = collections.Counter()
        for _, fr in x:
            app = []
            for name, binary in fr:
                if a.app in binary and name not in app:
                    app.append(name)
            for name in set(app):
                seen_per[name] += 1
        for name, n in seen_per.items():
            incl[name] += n
        # Most specific app frame covering >= 50% of the stretch.
        cover = [(n, name) for name, n in seen_per.items() if n >= 0.5 * len(x)]
        deepest = None
        if cover:
            depth = {}
            for _, fr in x:
                for d, (name, binary) in enumerate(fr):
                    if a.app in binary:
                        depth[name] = min(depth.get(name, 999), d)
            deepest = min(cover, key=lambda c: depth.get(c[1], 999))[1]
        print(f'  stall {dur:6.0f} ms at {x[0][0]/1e9:7.2f}s  main: {deepest or "(no app frame)"}'[:220])
    for needle in a.focus:
        focus(stretches if a.all else long, needle, a.top)
    if a.all:
        incl = collections.Counter()
        for x in stretches:
            for _, fr in x:
                for name in {n for n, b in fr if a.app in b}: incl[name] += 1
    print('\napp frames by main-thread ms ' + ('(all busy, inclusive):' if a.all else 'inside stalls (inclusive):'))
    for name, n in incl.most_common(a.top):
        print(f'  {n:6d} ms  {name}'[:200])


def focus(stretches, needle, top):
    callee = collections.Counter(); leaf = collections.Counter(); total = 0
    for x in stretches:
        for _, fr in x:
            # frames are leaf-first; find the outermost frame matching needle
            idx = max((i for i, (n, _) in enumerate(fr) if needle in n), default=None)
            if idx is None: continue
            total += 1
            if idx > 0: callee[fr[idx - 1][0]] += 1
            leaf[fr[0][0]] += 1
    print(f'\n== under "{needle}": {total} ms')
    print('  direct callees:')
    for n, c in callee.most_common(top): print(f'    {c:5d} ms  {n}'[:180])
    print('  self (leaf) frames:')
    for n, c in leaf.most_common(12): print(f'    {c:5d} ms  {n}'[:180])


if __name__ == '__main__':
    main()
