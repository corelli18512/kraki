#!/usr/bin/env python3
"""Real URLSession + Pulse tests against own loopback peer; never production."""
import json, os, pathlib, subprocess, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='kraki-reliability-net-') as tmp:
    b = pathlib.Path(tmp)
    src = ROOT / 'packages/arm/ios'
    subprocess.run(['swiftc', '-O', '-emit-library', '-emit-module', '-module-name', 'Pulse',
                    *map(str, (src/'Vendor/Pulse/Sources/Pulse').glob('*.swift')),
                    '-emit-module-path', str(b/'Pulse.swiftmodule'), '-o', str(b/'libPulse.dylib')], check=True)
    subprocess.run(['swiftc', '-swift-version', '5', '-I', tmp, '-L', tmp, '-lPulse',
                    str(src/'Kraki/Core/Networking/PulseManager.swift'),
                    str(src/'Kraki/Core/Networking/PayloadFragments.swift'),
                    str(src/'Kraki/Core/Networking/WebSocketClient.swift'),
                    str(ROOT/'scripts/diag/ReliabilityLoopback.swift'), '-o', str(b/'client')], check=True)
    peer = subprocess.Popen(['node', str(ROOT/'scripts/diag/reliability-peer.mjs')], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True)
    jobs = []
    try:
        port = json.loads(peer.stdout.readline())['port']
        for mode in ['slow-bulk', 'slow-auth', 'stall', 'half-open', 'auth-timeout', 'connect-timeout']:
            f = (b/f'{mode}.log').open('w+')
            proc = subprocess.Popen([str(b/'client'), str(port), mode], stdout=f, stderr=subprocess.STDOUT,
                                    env={**os.environ, 'DYLD_LIBRARY_PATH': tmp})
            jobs.append((mode, proc, f))
        failures = []
        for mode, proc, f in jobs:
            code = proc.wait(timeout=150)
            f.seek(0); print(f.read(), flush=True)
            if code: failures.append((mode, code))
        if failures: raise RuntimeError(failures)
    finally:
        for _, proc, f in jobs:
            if proc.poll() is None: proc.terminate(); proc.wait(timeout=10)
            f.close()
        if peer.poll() is None:
            peer.stdin.write('stop\n'); peer.stdin.flush()
            print(peer.communicate(timeout=10)[0], flush=True)
