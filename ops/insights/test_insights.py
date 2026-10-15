import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid
from indexer import Index
from metrics import distributions, percentile, pending_sends
from product import DAY, account_snapshot, combine_product, day_bounds
from run import build, peer_snapshot

NOW = 1792108800000  # 2026-10-16 00:00 UTC; Beijing 08:00
KEY = b'k' * 32


def event(ev='send.summary', at=NOW - 1000, **data):
    d = {'kind': 'typed', 'outcome': 'delivered', 'offline': False, 'background': False, 'confirmMs': 200, 'shown': 'none'} if ev == 'send.summary' else {}
    return dict(owner='a' * 64, platform='ios', version='1.0(1)', ev=ev, t=at, receivedAt=NOW, d={**d, **data})


def database(path, active=True):
    db = sqlite3.connect(path)
    db.execute('PRAGMA user_version = ' + ('14' if active else '13'))
    db.execute('CREATE TABLE users(user_id TEXT PRIMARY KEY, provider TEXT, created_at TEXT)')
    db.executemany('INSERT INTO users VALUES(?,?,?)', [('u1', 'github', '2026-10-14 18:00:00'), ('u2', 'github', '2026-10-15 16:00:00'), ('test', 'open', '2026-10-14 18:00:00')])
    if active:
        db.executescript("CREATE TABLE daily_active_users(day TEXT,user_id TEXT,PRIMARY KEY(day,user_id)); CREATE TABLE usage_metadata(key TEXT,value TEXT); INSERT INTO usage_metadata VALUES('started_at','2026-10-01T00:00:00Z');")
        db.execute('INSERT INTO daily_active_users VALUES(?,?)', (day_bounds(NOW - DAY)[0], 'u1'))
    db.commit(); db.close()


class InsightsTests(unittest.TestCase):
    def test_beijing_natural_day_boundaries(self):
        day, start, end = day_bounds(NOW)
        self.assertEqual(day, '2026-10-16')
        self.assertEqual(end - start, DAY)
        self.assertEqual(day_bounds(start - 1)[0], '2026-10-15')
        self.assertEqual(day_bounds(start)[0], '2026-10-16')

    def test_nearest_rank_quantiles_empty_and_single(self):
        self.assertIsNone(percentile([], .95))
        self.assertEqual(percentile([7], .95), 7)
        self.assertEqual(percentile(list(range(1, 21)), .95), 19)

    def test_only_successes_have_latency_but_failures_remain_visible(self):
        rows = [event(confirmMs=i * 1000) for i in range(1, 21)] + [event(outcome='abandoned', confirmMs=None)] * 5
        result, _ = distributions(rows, NOW - 900000, NOW)
        g = result[0]
        self.assertEqual((g['samples'], g['p95Ms'], g['failures'], g['failureRate']), (20, 19000, 5, .2))
        self.assertEqual(g['extreme'], 5)

    def test_exclude_offline_background_restart_and_group_versions_platforms(self):
        rows = [event(), event(offline=True), event(background=True), event(restored=1), event(at=NOW - DAY)]
        other = event(); other['version'] = '2.0(3)'; rows.append(other)
        other = event(); other['platform'] = 'mac'; rows.append(other)
        groups, excluded = distributions(rows, NOW - 900000, NOW)
        self.assertEqual(len(groups), 3)
        self.assertEqual(sum(g['total'] for g in groups), 3)
        self.assertEqual(excluded['send.summary'], 3)

    def test_cancelled_and_permission_are_not_voice_service_failures(self):
        rows = [event('voice.summary', outcome='final', finalizeMs=5000, correctionOn=False),
                event('voice.summary', outcome='failed', cause='network', correctionOn=False),
                event('voice.summary', outcome='failed', cause='permission', correctionOn=False),
                event('voice.summary', outcome='cancelled', correctionOn=False)]
        groups, _ = distributions(rows, NOW - 900000, NOW)
        g = groups[0]
        self.assertEqual((g['kind'], g['samples'], g['failures'], g['cancelled'], g['failureRate']), ('raw', 1, 1, 1, .5))

    def test_unknown_correction_and_agent_time_do_not_mix(self):
        groups, _ = distributions([event('voice.summary', outcome='final', finalizeMs=100),
                                  event('voice.summary', outcome='final', finalizeMs=200, correctionOn=True),
                                  event('reply.summary', outcome='completed', firstTextMs=100000, deltas=3, stalls=1)], NOW-900000, NOW)
        self.assertEqual(len(groups), 3)
        reply = next(g for g in groups if g['metric'] == 'reply')
        self.assertIsNone(reply['targetMs'])
        self.assertEqual((reply['observedReplies'], reply['stalls']), (1, 1))

    def test_unresolved_is_not_assumed_failed_and_echo_closes_across_processes(self):
        rows = [event('cmd.input', at=NOW-180000, clientId='a'), event('cmd.input', at=NOW-180000, clientId='b'),
                event('outbox.state', at=NOW-100000, clientId='a', phase='failed')]
        self.assertEqual(pending_sends(rows, NOW-900000, NOW)['unresolved'], 2)
        self.assertEqual(pending_sends(rows, NOW-900000, NOW)['explicitFailures'], 1)
        rows.append(event('echo.input', clientId='a', matched=True))
        self.assertEqual(pending_sends(rows, NOW-900000, NOW)['explicitFailures'], 0)

    def test_readonly_registry_global_dedup_and_partial_peer(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'head.db'; database(path)
            original = hashlib.sha256(path.read_bytes()).digest()
            primary = account_snapshot(path, KEY, True, NOW)
            edge = account_snapshot(path, KEY, False, NOW)
            self.assertEqual(primary['registration']['total'], 2)
            yesterday = day_bounds(NOW-DAY)[0]
            self.assertEqual(primary['registration']['newByDay'][yesterday], 1)
            self.assertIsNone(edge['registration'])
            combined = combine_product(primary, edge, NOW)
            self.assertEqual(combined['days'][yesterday]['observedDau'], 1)
            self.assertTrue(combined['days'][yesterday]['dayComplete'])
            self.assertNotIn('u1', json.dumps(primary))
            self.assertEqual(original, hashlib.sha256(path.read_bytes()).digest())
            self.assertIsNone(combine_product(primary, None, NOW)['days'][yesterday]['observedDau'])
            edge['asOf'] = NOW-200000
            self.assertIsNone(combine_product(primary, edge, NOW)['days'][yesterday]['observedDau'])
            edge['asOf'] = NOW; edge['keyId'] = 'mismatch'
            self.assertIsNone(combine_product(primary, edge, NOW)['days'][yesterday]['observedDau'])

    def test_old_head_is_unknown_not_zero_and_ambiguous_primary_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'head.db'; database(path, False)
            p=account_snapshot(path, KEY, True, NOW)
            self.assertEqual(p['activity'], {})
            day=day_bounds(NOW-DAY)[0]
            self.assertIsNone(combine_product(p,p,NOW)['days'][day]['observedDau'])
            self.assertIsNone(combine_product(p,p,NOW)['registration'], 'two primary sources must not be summed')

    def test_pre_collection_history_unknown_but_first_day_has_partial_observations(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'head.db'; database(path)
            primary=account_snapshot(path, KEY, True, NOW)
            edge=account_snapshot(path, KEY, False, NOW)
            today, start, _=day_bounds(NOW)
            yesterday=day_bounds(NOW-DAY)[0]
            # Even one host starting exactly at the next day's boundary means
            # there was no global observation coverage on the preceding day.
            edge['activityStartedAt']='2026-10-15T16:00:00Z'
            days=combine_product(primary,edge,NOW)['days']
            self.assertIsNone(days[yesterday]['observedDau'])
            self.assertFalse(days[yesterday]['dayComplete'])
            self.assertEqual(days[today]['observedDau'],0)
            self.assertTrue(days[today]['dayComplete'])
            edge['activityStartedAt']='2026-10-15T18:00:00Z'
            days=combine_product(primary,edge,NOW)['days']
            self.assertIsNone(days[yesterday]['observedDau'])
            self.assertEqual(days[today]['observedDau'],0)
            self.assertFalse(days[today]['dayComplete'])
            edge['activityStartedAt']=None
            self.assertIsNone(combine_product(primary,edge,NOW)['days'][today]['observedDau'])

    def test_rollback_to_old_schema_does_not_claim_activity_collection(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'head.db'; database(path)
            db=sqlite3.connect(path);db.execute('PRAGMA user_version=13');db.close()
            snapshot=account_snapshot(path, KEY, True, NOW)
            self.assertEqual(snapshot['registration']['total'],2)
            self.assertEqual(snapshot['activity'],{},'retained additive tables do not prove the old relay records foreground pings')

    def test_index_dedup_retry_late_future_corrupt_and_bounded_backlog(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); owner=root/'diag'/('a'*64); owner.mkdir(parents=True)
            index=Index(root/'index.db')
            process=str(uuid.uuid4())
            def batch(events, seq, received=NOW):
                path=owner/(str(uuid.UUID(int=seq))+'.json.gz')
                path.write_bytes(gzip.compress(json.dumps({'platform':'ios','version':'1.0','build':'1','processId':process,'events':events}).encode()))
                os.utime(path,(received/1000,received/1000)); return path
            rows=[dict(t=NOW-1000,seq=1,ev='send.summary',d=event()['d']),
                  dict(t=NOW-DAY,seq=2,ev='send.summary',d=event()['d']),
                  dict(t=NOW+300000,seq=3,ev='send.summary',d=event()['d'])]
            batch(rows, 1); batch(rows, 2)
            r=index.ingest(root/'diag', NOW, max_files=1)
            self.assertTrue(r['backlog']); self.assertEqual(r['future'], 1)
            r=index.ingest(root/'diag', NOW)
            self.assertEqual(r['duplicates'], 2)
            all_events=index.events(NOW-2*DAY,NOW)
            recent,_=distributions(all_events,NOW-900000,NOW)
            self.assertEqual(recent[0]['samples'],1, 'late upload goes to its event day, not recent window')
            self.assertEqual(index.ingest(root/'diag',NOW)['scanned'],0)
            bad=owner/(str(uuid.uuid4())+'.json.gz'); bad.write_bytes(b'corrupt')
            self.assertEqual(index.ingest(root/'diag',NOW)['invalid'],1)
            index.close()

    def test_peer_uses_only_dedicated_identity_and_rejects_wrong_or_invalid_exports(self):
        config={'peer': {'host':'cn','keyFile':'/private/dedicated-key',
                        'knownHostsFile':'/private/pinned-host','destination':'root@example.invalid'}}
        valid={'schema':1,'host':'cn','product':{}}
        with patch('run.subprocess.run') as ssh:
            ssh.return_value=subprocess.CompletedProcess([],0,json.dumps(valid).encode(),b'')
            self.assertEqual(peer_snapshot(config),valid)
            args=ssh.call_args.args[0]
            self.assertEqual(args[args.index('-F')+1],'/dev/null')
            for option in ['ControlPath=none','IdentityAgent=none','IdentitiesOnly=yes',
                           'StrictHostKeyChecking=yes','ClearAllForwardings=yes','BatchMode=yes']:
                self.assertIn(option,args)
            self.assertEqual(ssh.call_args.kwargs['timeout'],8)
            for raw in [b'not json', b'{"schema":1,"host":"wrong"}', b'{"schema":2,"host":"cn"}']:
                ssh.return_value=subprocess.CompletedProcess([],0,raw,b'')
                self.assertIsNone(peer_snapshot(config))

    def test_real_build_produces_redacted_summary_and_no_head_writes(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); (root/'diag').mkdir(); (root/'state').mkdir(); (root/'key').write_bytes(KEY)
            database(root/'head.db', False)
            before=(root/'head.db').read_bytes()
            snapshot=build({'host':'tokyo','primary':True,'headDb':str(root/'head.db'),'hmacKeyFile':str(root/'key'),'diagDirectory':str(root/'diag')},root/'state',NOW)
            self.assertEqual(snapshot['recent'],[])
            summary=json.loads((root/'state'/'summary.json').read_text())
            self.assertEqual(summary['product']['registration']['total'],2)
            self.assertNotIn('keyId',json.dumps(summary))
            self.assertEqual(before,(root/'head.db').read_bytes())


if __name__=='__main__': unittest.main()
