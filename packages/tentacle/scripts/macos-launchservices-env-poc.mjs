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
const parentSource = join(root, 'parent.swift');
const helperSource = join(root, 'helper.swift');
const helperPath = join(root, 'ExternalAppKitHelper');

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

writeFileSync(helperSource, String.raw`
import AppKit
import Foundation
import Darwin

let resultDir = CommandLine.arguments[1]
let inherited = ProcessInfo.processInfo.environment["__CFBundleIdentifier"] ?? "<missing>"
// Force the external, non-bundled child through the same AppKit/LaunchServices
// check-in path that can turn an inherited private bundle variable into a
// runtime application identity.
_ = NSApplication.shared
try! inherited.write(toFile: resultDir + "/child.bundle-env", atomically: true, encoding: .utf8)
try! String(getpid()).write(toFile: resultDir + "/child.pid", atomically: true, encoding: .utf8)
while true { sleep(1) }
`);
execFileSync('/usr/bin/swiftc', [helperSource, '-o', helperPath], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', helperPath], { stdio: 'inherit' });

writeFileSync(parentSource, String.raw`
import Foundation
import Darwin

let mode = CommandLine.arguments[1]
let resultDir = CommandLine.arguments[2]
let helperPath = CommandLine.arguments[3]

if mode == "scrub" {
  unsetenv("__CFBundleIdentifier")
}

let child = Process()
child.executableURL = URL(fileURLWithPath: helperPath)
child.arguments = [resultDir]
try! child.run()

try! String(getpid()).write(toFile: resultDir + "/parent.pid", atomically: true, encoding: .utf8)
while true { sleep(1) }
`);

const cases = [
  { mode: 'inherit', expectedChildEnv: null, expectedChildIdentity: null },
  { mode: 'scrub', expectedChildEnv: '<missing>', expectedChildIdentity: null },
];

try {
  for (const testCase of cases) {
    const caseDir = join(root, testCase.mode);
    const app = join(caseDir, 'LaunchIdentityPoc.app');
    const macos = join(app, 'Contents', 'MacOS');
    const parentPath = join(macos, 'LaunchIdentityPoc');
    const bundleId = `chat.kraki.launch-identity-poc.${testCase.mode}.${process.pid}`;
    mkdirSync(macos, { recursive: true });
    execFileSync('/usr/bin/swiftc', [parentSource, '-o', parentPath], { stdio: 'inherit' });
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

    const open = spawn('/usr/bin/open', ['-W', '-n', '-a', app, '--args', testCase.mode, caseDir, helperPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let parentPid = 0;
    let childPid = 0;
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const parentPidPath = join(caseDir, 'parent.pid');
        const childPidPath = join(caseDir, 'child.pid');
        if (existsSync(parentPidPath) && existsSync(childPidPath)) {
          parentPid = Number(readFileSync(parentPidPath, 'utf8'));
          childPid = Number(readFileSync(childPidPath, 'utf8'));
          if (parentPid > 0 && childPid > 0) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!parentPid || !childPid) throw new Error(`${testCase.mode}: app/helper did not publish PIDs`);

      let parentIdentity = null;
      let childIdentity = null;
      let childEnv = null;
      const identityDeadline = Date.now() + 10_000;
      while (Date.now() < identityDeadline) {
        parentIdentity = bundleIdentity(parentPid);
        childIdentity = bundleIdentity(childPid);
        const childEnvPath = join(caseDir, 'child.bundle-env');
        childEnv = existsSync(childEnvPath) ? readFileSync(childEnvPath, 'utf8') : null;
        const expectedChildEnv = testCase.expectedChildEnv ?? bundleId;
        const expectedChildIdentity = testCase.expectedChildIdentity ?? (testCase.mode === 'inherit' ? bundleId : null);
        if (
          parentIdentity === bundleId &&
          childEnv === expectedChildEnv &&
          childIdentity === expectedChildIdentity
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const expectedChildEnv = testCase.expectedChildEnv ?? bundleId;
      const expectedChildIdentity = testCase.expectedChildIdentity ?? (testCase.mode === 'inherit' ? bundleId : null);
      if (parentIdentity !== bundleId) {
        throw new Error(`${testCase.mode}: parent identity mismatch: expected ${bundleId}, got ${parentIdentity}`);
      }
      if (childEnv !== expectedChildEnv) {
        throw new Error(`${testCase.mode}: expected child bundle env ${expectedChildEnv}, got ${childEnv}`);
      }
      if (childIdentity !== expectedChildIdentity) {
        throw new Error(`${testCase.mode}: expected child identity ${expectedChildIdentity}, got ${childIdentity}`);
      }

      console.log(
        `✅ ${testCase.mode}: parent=${parentIdentity} child-env=${childEnv} child-identity=${childIdentity ?? 'null'}`,
      );
    } finally {
      terminate(childPid);
      terminate(parentPid);
      if (open.pid) terminate(open.pid);
    }
  }

  console.log('✅ macOS Launch Services environment/identity PoC passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
