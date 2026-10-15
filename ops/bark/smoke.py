#!/usr/bin/env python3
"""Test the real upstream binary in a disposable DB, not a production identity.
No /push requests: this cannot send a notification. Prints no device keys.
"""
import json
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

with tempfile.TemporaryDirectory(prefix='bark-smoke-') as state:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    process = subprocess.Popen([
        sys.argv[1], '--addr', f'127.0.0.1:{port}', '--url-prefix', '/bark',
        '--data', state,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f'http://127.0.0.1:{port}/bark'

    def request(path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=3) as response:
            return json.load(response)

    try:
        for _ in range(30):
            try:
                if request('/ping')['code'] == 200:
                    break
            except (OSError, urllib.error.URLError):
                time.sleep(0.1)
        else:
            raise RuntimeError('temporary Bark did not become ready')
        # Same GET registration route and response fields as the official App.
        registered = request('/register?devicetoken=' + 'a' * 64)
        key = registered['data']['key']
        assert key and registered['data']['device_key'] == key
        updated = request('/register?' + urllib.parse.urlencode({'key': key, 'devicetoken': 'b' * 64}))
        assert updated['data']['key'] == key
        assert updated['data']['device_token'] == 'b' * 64
        updated = request('/register', {'device_key': key, 'device_token': 'c' * 64})
        assert updated['data']['device_key'] == key
        try:
            request('/register')
            raise AssertionError('empty registration should fail')
        except urllib.error.HTTPError as error:
            assert error.code == 400
        print('PASS: prefixed ping, App GET registration, stable key refresh, POST registration, empty request rejection; no push sent')
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
