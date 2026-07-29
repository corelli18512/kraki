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

async function waitFor(label, timeoutMs, read) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = read();
    if (last !== undefined) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

writeFileSync(helperSource, String.raw`
import AppKit
import Foundation
import Darwin

let resultDir = CommandLine.arguments[1]
let inherited = ProcessInfo.processInfo.environment["__CFBundleIdentifier"] ?? "<missing>"
// Force this bundle-external child through AppKit/LaunchServices check-in.
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
let gatePath = resultDir + "/spawn-child"

try! String(getpid()).write(toFile: resultDir + "/parent.pid", atomically: true, encoding: .utf8)
while !FileManager.default.fileExists(atPath: gatePath) { usleep(100_000) }

if mode == "scrub" {
  unsetenv("__CFBundleIdentifier")
}

let child = Process()
child.executableURL = URL(fileURLWithPath: helperPath)
child.arguments = [resultDir]
try! child.run()
while true { sleep(1) }
`);

try {
  for (const mode of ['inherit', 'scrub']) {
    const caseDir = join(root, mode);
    const app = join(caseDir, 'LaunchIdentityPoc.app');
    const macos = join(app, 'Contents', 'MacOS');
    const parentPath = join(macos, 'LaunchIdentityPoc');
    const bundleId = `chat.kraki.launch-identity-poc.${mode}.${process.pid}`;
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

    const open = spawn('/usr/bin/open', ['-W', '-n', '-a', app, '--args', mode, caseDir, helperPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let parentPid = 0;
    let childPid = 0;
    try {
      parentPid = await waitFor(`${mode}: parent PID`, 15_000, () => {
        const path = join(caseDir, 'parent.pid');
        if (!existsSync(path)) return undefined;
        const pid = Number(readFileSync(path, 'utf8'));
        return pid > 0 ? pid : undefined;
      });

      const beforeChildIdentity = await waitFor(`${mode}: parent pre-child identity`, 10_000, () => {
        const identity = bundleIdentity(parentPid);
        return identity === bundleId ? identity : undefined;
      });

      writeFileSync(join(caseDir, 'spawn-child'), 'go\n');
      childPid = await waitFor(`${mode}: child PID`, 15_000, () => {
        const path = join(caseDir, 'child.pid');
        if (!existsSync(path)) return undefined;
        const pid = Number(readFileSync(path, 'utf8'));
        return pid > 0 ? pid : undefined;
      });
      const childEnv = readFileSync(join(caseDir, 'child.bundle-env'), 'utf8');

      // Give AppKit/LaunchServices time to process the external child's check-in.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const afterChildIdentity = bundleIdentity(parentPid);
      const childIdentity = bundleIdentity(childPid);

      if (mode === 'inherit') {
        if (childEnv !== bundleId) {
          throw new Error(`inherit: expected child env ${bundleId}, got ${childEnv}`);
        }
        if (afterChildIdentity === bundleId && childIdentity !== bundleId) {
          throw new Error(
            `inherit: external child inherited ${bundleId} but did not reproduce an identity collision ` +
            `(parent=${afterChildIdentity}, child=${childIdentity})`,
          );
        }
      } else {
        if (childEnv !== '<missing>') {
          throw new Error(`scrub: expected child env to be missing, got ${childEnv}`);
        }
        if (afterChildIdentity !== bundleId) {
          throw new Error(`scrub: parent lost identity: expected ${bundleId}, got ${afterChildIdentity}`);
        }
        if (childIdentity === bundleId) {
          throw new Error('scrub: external child still acquired the parent bundle identity');
        }
      }

      console.log(
        `✅ ${mode}: before=${beforeChildIdentity} after=${afterChildIdentity ?? 'null'} ` +
        `child-env=${childEnv} child-identity=${childIdentity ?? 'null'}`,
      );
    } finally {
      terminate(childPid);
      terminate(parentPid);
      if (open.pid) terminate(open.pid);
    }
  }

  console.log('✅ macOS Launch Services identity-collision PoC passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
