const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { POWER_CHANNEL, forwardPowerEvents } = require('../src/power.cjs');

test('suspend and resume reach the app window as fixed values; other power events do not', () => {
  const monitor = new EventEmitter();
  const sent = [];
  forwardPowerEvents(monitor, (channel, payload) => sent.push([channel, payload]));
  monitor.emit('suspend', { secret: 1 });
  monitor.emit('lock-screen');
  monitor.emit('resume');
  assert.deepEqual(sent, [[POWER_CHANNEL, 'suspend'], [POWER_CHANNEL, 'resume']]);
});
