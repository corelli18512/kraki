#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'darwin') {
  console.log('macOS Launch Services PoC skipped on non-macOS');
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'kraki-ls-env-poc-'));
const source = join(root, 'main.swift');

function bundleIdentity(pid) {
  try {
    const out = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.match(/"CFBundleIdentifier"\s*=\s*"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function terminate(pid) {
  if (!pid || !alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && alive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

writeFileSync(source, String.raw`
import Foundation
import Darwin

let args = CommandLine.arguments
let mode = args[1]
let resultDir = args[2]

if mode == "child" {
  while true { sleep(1) }
}

if mode == "scrub" {
  unsetenv("__CFBundleIdentifier")
}

let child = Process()
child.executableURL = URL(fileURLWithPath: args[0])
child.arguments = ["child", resultDir]
try! child.run()

let parentPid = String(getpid())
let childPid = String(child.processIdentifier)
try! parentPid.write(toFile: resultDir + "/parent.pid", atomically: true, encoding: .utf8)
try! childPid.write(toFile: resultDir + "/child.pid", atomically: true, encoding: .utf8)

while true { sleep(1) }
`);

const cases = [
  { mode: 'inherit', expectChildIdentity: true },
  { mode: 'scrub', expectChildIdentity: false },
];

try {
  for (const testCase of cases) {
    const caseDir = join(root, testCase.mode);
    const app = join(caseDir, 'LaunchIdentityPoc.app');
    const macos = join(app, 'Contents', 'MacOS');
    const bundleId = `chat.kraki.launch-identity-poc.${testCase.mode}.${process.pid}`;
    mkdirSync(macos, { recursive: true });
    execFileSync('/usr/bin/swiftc', [source, '-o', join(macos, 'LaunchIdentityPoc')], { stdio: 'inherit' });
    writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>LaunchIdentityPoc</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>LaunchIdentityPoc</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });

    const open = spawn('/usr/bin/open', ['-W', '-n', '-a', app, '--args', testCase.mode, caseDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let parentPid = 0;
    let childPid = 0;
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const parentPath = join(caseDir, 'parent.pid');
        const childPath = join(caseDir, 'child.pid');
        if (existsSync(parentPath) && existsSync(childPath)) {
          parentPid = Number(readFileSync(parentPath, 'utf8'));
          childPid = Number(readFileSync(childPath, 'utf8'));
          if (parentPid > 0 && childPid > 0) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!parentPid || !childPid) throw new Error(`${testCase.mode}: app did not publish PIDs`);

      // Launch Services check-in is asynchronous. Wait for the parent identity
      // and, in the inherited case, the child identity to settle.
      let parentIdentity = null;
      let childIdentity = null;
      const identityDeadline = Date.now() + 10_000;
      while (Date.now() < identityDeadline) {
        parentIdentity = bundleIdentity(parentPid);
        childIdentity = bundleIdentity(childPid);
        if (parentIdentity === bundleId && (testCase.expectChildIdentity ? childIdentity === bundleId : childIdentity === null)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (parentIdentity !== bundleId) {
        throw new Error(`${testCase.mode}: parent identity mismatch: expected ${bundleId}, got ${parentIdentity}`);
      }
      if (testCase.expectChildIdentity && childIdentity !== bundleId) {
        throw new Error(`${testCase.mode}: expected inherited child identity ${bundleId}, got ${childIdentity}`);
      }
      if (!testCase.expectChildIdentity && childIdentity !== null) {
        throw new Error(`${testCase.mode}: expected scrubbed child identity to be null, got ${childIdentity}`);
      }

      console.log(`✅ ${testCase.mode}: parent=${parentIdentity} child=${childIdentity ?? 'null'}`);
    } finally {
      terminate(childPid);
      terminate(parentPid);
      if (open.pid) terminate(open.pid);
    }
  }

  console.log('✅ macOS Launch Services environment PoC passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
