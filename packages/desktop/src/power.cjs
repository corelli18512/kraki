// System sleep/wake for the app window's performance data (the Web client's
// StabilityTracker: a sleep ends open records, the next visibility is a
// `wake` opening, like Mac's willSleep). Only these two fixed values are sent.
const POWER_CHANNEL = 'kraki:power';

function forwardPowerEvents(powerMonitor, send) {
  powerMonitor.on('suspend', () => send(POWER_CHANNEL, 'suspend'));
  powerMonitor.on('resume', () => send(POWER_CHANNEL, 'resume'));
}

module.exports = { POWER_CHANNEL, forwardPowerEvents };
