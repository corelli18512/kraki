import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(new URL('../../.github/workflows/ios-testflight.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** The `run:` script of a step, dedented. */
function stepScript(name) {
  const step = workflow.split(`\n      - name: ${name}\n`)[1].split(/\n      - name: /)[0];
  return step.split('\n        run: |\n')[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
}

test('Select Xcode fails before the archive when the selected Xcode has no altool', () => {
  const script = stepScript('Select Xcode');
  assert.match(script, /if ! ALTOOL="\$\(xcrun --find altool\)" \|\| \[ ! -x "\$ALTOOL" \]; then\n.*\n\s*exit 1/);
  assert.ok(workflow.indexOf('- name: Select Xcode') < workflow.indexOf('- name: Archive Kraki for App Store Connect'));
  // The upload uses the same tool.
  assert.match(stepScript('Upload IPA to TestFlight'), /xcrun altool --upload-app/);
});

/** The DTSDKName loop of "Validate archive metadata", run on a fake archive. */
function checkArchiveSdk(appSdk, extensionSdk) {
  const script = stepScript('Validate archive metadata');
  const loop = script.slice(script.indexOf('for BUNDLE in "$APP" "$APP/PlugIns/KrakiNotification.appex"; do\n  SDK_NAME'),
    script.indexOf('\ndone\n', script.indexOf('DTSDKName')) + 5);
  const app = join(mkdtempSync(join(tmpdir(), 'ios-testflight-')), 'Kraki.app');
  for (const [bundle, sdk] of [[app, appSdk], [join(app, 'PlugIns/KrakiNotification.appex'), extensionSdk]]) {
    mkdirSync(bundle, { recursive: true });
    spawnSync('/usr/libexec/PlistBuddy', ['-c', `Add :DTSDKName string ${sdk}`, join(bundle, 'Info.plist')]);
  }
  return spawnSync('bash', ['-euo', 'pipefail', '-c', loop], {
    encoding: 'utf8', env: { ...process.env, APP: app, MIN_IOS_SDK_MAJOR: '27' },
  });
}
const macOS = { skip: process.platform !== 'darwin' && 'PlistBuddy runs on the macOS release runner only' };

test('the archive SDK check covers the app and the notification extension', () => {
  assert.match(stepScript('Validate archive metadata'),
    /for BUNDLE in "\$APP" "\$APP\/PlugIns\/KrakiNotification\.appex"; do\n {2}SDK_NAME="\$\(\/usr\/libexec\/PlistBuddy -c 'Print :DTSDKName' "\$BUNDLE\/Info\.plist"\)"/);
});

test('the archive SDK check passes iOS 27 bundles and stops an older extension', macOS, () => {
  const ok = checkArchiveSdk('iphoneos27.1', 'iphoneos27.1');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /KrakiNotification\.appex archived with iphoneos27\.1/);
  const oldExtension = checkArchiveSdk('iphoneos27.1', 'iphoneos26.5');
  assert.equal(oldExtension.status, 1);
  assert.match(oldExtension.stdout, /::error::KrakiNotification\.appex was built with iphoneos26\.5/);
  assert.equal(checkArchiveSdk('iphoneos26.5', 'iphoneos27.1').status, 1);
  assert.equal(checkArchiveSdk('', 'iphoneos27.1').status, 1, 'a missing DTSDKName fails closed');
});
