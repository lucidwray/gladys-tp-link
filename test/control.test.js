import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES } from '@gladysassistant/integration-sdk';
import { handleSetValue } from '../src/setValue.js';
import { handlePoll } from '../src/poll.js';
import { buildDevice } from '../src/tplink/model.js';
import { PARAMS, TRANSPORTS } from '../src/constants.js';
import { normalizeConfig } from '../src/config.js';
import { resetPublishedState } from '../src/statePublisher.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeTpLink, PLUG_SYSINFO, BULB_SYSINFO, DIMMER_SYSINFO } from './helpers/fakeTpLink.js';

const config = normalizeConfig();

function buildPlug(gladys, host = '192.168.1.10') {
  return buildDevice(gladys, PLUG_SYSINFO, host, config).device;
}

// A dimmer as discovered after the brightness feature was added: the on-off
// feature first, then the brightness feature.
function buildDimmer(gladys, host = '192.168.1.20') {
  return buildDevice(gladys, DIMMER_SYSINFO, host, config).device;
}

// The publisher deduplicates through module-level state, so each test must
// start from a clean slate.
beforeEach(() => resetPublishedState());

// --- setValue ---------------------------------------------------------------

test('handleSetValue turns a plug ON and publishes the state read back', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.10': { ...PLUG_SYSINFO, relay_state: 0 } } });
  const device = buildPlug(gladys);
  const feature = device.features[0];

  await handleSetValue(gladys, tpClient, { device, feature, value: 1 });

  assert.deepEqual(tpClient.powerCommands, [{ host: '192.168.1.10', on: true }]);
  assert.deepEqual(gladys.published, [{ featureExternalId: feature.external_id, state: 1 }]);
});

test('handleSetValue turns a plug OFF', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.10': PLUG_SYSINFO } });
  const device = buildPlug(gladys);
  const feature = device.features[0];

  await handleSetValue(gladys, tpClient, { device, feature, value: 0 });

  assert.deepEqual(tpClient.powerCommands, [{ host: '192.168.1.10', on: false }]);
  assert.equal(gladys.published[0].state, 0);
});

test('handleSetValue accepts a value handed back as a string', async () => {
  // A strict `value === 1` would read '1' as OFF: "turn on" would turn off.
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.10': { ...PLUG_SYSINFO, relay_state: 0 } } });
  const device = buildPlug(gladys);

  await handleSetValue(gladys, tpClient, { device, feature: device.features[0], value: '1' });

  assert.deepEqual(tpClient.powerCommands, [{ host: '192.168.1.10', on: true }]);
});

test('handleSetValue rejects a value that is neither 0 nor 1 instead of turning off', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.10': PLUG_SYSINFO } });
  const device = buildPlug(gladys);

  await assert.rejects(
    () => handleSetValue(gladys, tpClient, { device, feature: device.features[0], value: 42 }),
    /Unsupported value/,
  );
  assert.equal(tpClient.powerCommands.length, 0);
});

test('handleSetValue rejects a feature category it does not manage', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.10': PLUG_SYSINFO } });
  const device = buildPlug(gladys);
  const feature = { external_id: 'x', category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR };

  await assert.rejects(() => handleSetValue(gladys, tpClient, { device, feature, value: 1 }), /no On\/Off control/);
  assert.equal(tpClient.powerCommands.length, 0);
});

test('handleSetValue resolves the IP from getDevices() when the event device is lightweight', async () => {
  const gladys = createFakeGladys();
  const full = buildPlug(gladys, '192.168.1.55');
  gladys.devices = [full];
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.55': { ...PLUG_SYSINFO, relay_state: 0 } } });

  const lightweight = { external_id: full.external_id };

  await handleSetValue(gladys, tpClient, { device: lightweight, feature: full.features[0], value: 1 });
  assert.deepEqual(tpClient.powerCommands, [{ host: '192.168.1.55', on: true }]);
});

test('handleSetValue refuses to command an address now held by another device', async () => {
  // DHCP lease reassigned: without the serial check the user would switch a
  // completely different device, with no warning at all.
  const gladys = createFakeGladys();
  const device = buildPlug(gladys);
  const tpClient = createFakeTpLink({
    byHost: { '192.168.1.10': { ...PLUG_SYSINFO, deviceId: 'SOMEONE_ELSE' } },
  });

  await assert.rejects(
    () => handleSetValue(gladys, tpClient, { device, feature: device.features[0], value: 1 }),
    /Another device now answers/,
  );
  assert.equal(tpClient.powerCommands.length, 0);
  assert.equal(gladys.published.length, 0);
});

test('handleSetValue replaces the raw driver error and flags the device unreachable', async () => {
  const gladys = createFakeGladys();
  const device = buildPlug(gladys);
  const tpClient = createFakeTpLink({ byHost: {} }); // nothing answers

  await assert.rejects(
    () => handleSetValue(gladys, tpClient, { device, feature: device.features[0], value: 1 }),
    (err) => {
      assert.match(err.message, /unreachable at 192\.168\.1\.10/);
      assert.doesNotMatch(err.message, /TCP Timeout|get_sysinfo/); // no protocol noise
      return true;
    },
  );
  assert.deepEqual(gladys.transports, [{ external_id: device.external_id, transport: TRANSPORTS.UNREACHABLE }]);
});

test('handleSetValue still publishes the state when the transport badge cannot be published', async () => {
  // The command reached the device: a failed badge update must neither hide
  // the new state nor report the command as failed.
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.10': { ...PLUG_SYSINFO, relay_state: 0 } } });
  const device = buildPlug(gladys);
  const feature = device.features[0];
  gladys.failNext('publishTransports');

  await handleSetValue(gladys, tpClient, { device, feature, value: 1 });

  assert.deepEqual(gladys.published, [{ featureExternalId: feature.external_id, state: 1 }]);
});

test('handleSetValue publishes the requested state when the device state could not be read back', async () => {
  const gladys = createFakeGladys();
  const device = buildPlug(gladys);
  const feature = device.features[0];
  // The command went through but the read-back ran out of time (see
  // src/tplink/client.js): the wrapper returns null instead of a sysinfo.
  const tpClient = { setPowerState: async () => null };

  await handleSetValue(gladys, tpClient, { device, feature, value: 1 });

  assert.deepEqual(gladys.published, [{ featureExternalId: feature.external_id, state: 1 }]);
});

test('handleSetValue still reports the failure when the unreachable badge cannot be published', async () => {
  const gladys = createFakeGladys();
  const device = buildPlug(gladys);
  const tpClient = createFakeTpLink({ byHost: {} }); // nothing answers
  gladys.failNext('publishTransports');

  await assert.rejects(
    () => handleSetValue(gladys, tpClient, { device, feature: device.features[0], value: 1 }),
    /unreachable at 192\.168\.1\.10/,
  );
});

test('handleSetValue reports a device with no stored address', async () => {
  const gladys = createFakeGladys();
  const device = buildPlug(gladys);
  device.params = device.params.filter((p) => p.name !== PARAMS.IP_ADDRESS);
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.10': PLUG_SYSINFO } });

  await assert.rejects(
    () => handleSetValue(gladys, tpClient, { device, feature: device.features[0], value: 1 }),
    /No address stored/,
  );
});

// --- setValue: dimmer brightness ----------------------------------------------

test('handleSetValue sets a dimmer brightness and turns it on when it was off', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({
    byHost: { '192.168.1.20': { ...DIMMER_SYSINFO, relay_state: 0, brightness: 10 } },
  });
  const device = buildDimmer(gladys);
  const [onOff, brightness] = device.features;

  await handleSetValue(gladys, tpClient, { device, feature: brightness, value: 50 });

  assert.deepEqual(tpClient.brightnessCommands, [{ host: '192.168.1.20', level: 50 }]);
  assert.deepEqual(tpClient.powerCommands, [{ host: '192.168.1.20', on: true }]);
  assert.deepEqual(gladys.published, [
    { featureExternalId: onOff.external_id, state: 1 },
    { featureExternalId: brightness.external_id, state: 50 },
  ]);
});

test('handleSetValue sets a dimmer brightness without a power command when it was already on', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.20': DIMMER_SYSINFO } });
  const device = buildDimmer(gladys);

  await handleSetValue(gladys, tpClient, { device, feature: device.features[1], value: 50 });

  assert.deepEqual(tpClient.brightnessCommands, [{ host: '192.168.1.20', level: 50 }]);
  assert.deepEqual(tpClient.powerCommands, []);
  assert.equal(gladys.published.find((p) => p.featureExternalId === device.features[1].external_id).state, 50);
});

test('handleSetValue rounds a non-integer brightness and accepts a numeric string', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.20': DIMMER_SYSINFO } });
  const device = buildDimmer(gladys);
  const brightness = device.features[1];

  await handleSetValue(gladys, tpClient, { device, feature: brightness, value: 49.6 });
  await handleSetValue(gladys, tpClient, { device, feature: brightness, value: '20' });

  assert.deepEqual(
    tpClient.brightnessCommands.map((c) => c.level),
    [50, 20],
  );
});

test('handleSetValue turns a dimmer off at brightness 0 and keeps its stored level', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.20': DIMMER_SYSINFO } });
  const device = buildDimmer(gladys);
  const [onOff, brightness] = device.features;

  await handleSetValue(gladys, tpClient, { device, feature: brightness, value: 0 });

  assert.deepEqual(tpClient.brightnessCommands, []); // the level is not overwritten with 0
  assert.deepEqual(tpClient.powerCommands, [{ host: '192.168.1.20', on: false }]);
  // The read-back still reports the stored level, so it is what gets published.
  assert.deepEqual(gladys.published, [
    { featureExternalId: onOff.external_id, state: 0 },
    { featureExternalId: brightness.external_id, state: DIMMER_SYSINFO.brightness },
  ]);
});

test('handleSetValue rejects a brightness outside 0-100 or not a number', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.20': DIMMER_SYSINFO } });
  const device = buildDimmer(gladys);

  for (const value of [-1, 101, 'x', '', null, NaN]) {
    await assert.rejects(
      () => handleSetValue(gladys, tpClient, { device, feature: device.features[1], value }),
      /Unsupported value for a brightness control/,
    );
  }
  assert.equal(tpClient.brightnessCommands.length, 0);
  assert.equal(tpClient.powerCommands.length, 0);
  assert.equal(gladys.published.length, 0);
});

test('handleSetValue still switches a dimmer with the on-off feature', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.20': { ...DIMMER_SYSINFO, relay_state: 0 } } });
  const device = buildDimmer(gladys);

  await handleSetValue(gladys, tpClient, { device, feature: device.features[0], value: 1 });

  assert.deepEqual(tpClient.powerCommands, [{ host: '192.168.1.20', on: true }]);
  assert.deepEqual(tpClient.brightnessCommands, []);
});

test('handleSetValue publishes the requested brightness when the read-back is unavailable', async () => {
  const gladys = createFakeGladys();
  const device = buildDimmer(gladys);
  const [onOff, brightness] = device.features;
  // The command went through but the read-back ran out of time (see
  // src/tplink/client.js): the wrapper returns null instead of a sysinfo.
  const tpClient = { setBrightness: async () => null };

  await handleSetValue(gladys, tpClient, { device, feature: brightness, value: 30 });

  assert.deepEqual(gladys.published, [
    { featureExternalId: onOff.external_id, state: 1 },
    { featureExternalId: brightness.external_id, state: 30 },
  ]);
});

test('handleSetValue publishes only the off state at brightness 0 when the read-back is unavailable', async () => {
  const gladys = createFakeGladys();
  const device = buildDimmer(gladys);
  const [onOff, brightness] = device.features;
  const tpClient = { setPowerState: async () => null };

  await handleSetValue(gladys, tpClient, { device, feature: brightness, value: 0 });

  assert.deepEqual(gladys.published, [{ featureExternalId: onOff.external_id, state: 0 }]);
});

test('handleSetValue publishes only the brightness when the dimmer has no on-off feature', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.20': DIMMER_SYSINFO } });
  const device = buildDimmer(gladys);
  device.features = [device.features[1]];
  gladys.devices = [device];

  await handleSetValue(gladys, tpClient, { device, feature: device.features[0], value: 40 });

  assert.deepEqual(gladys.published, [{ featureExternalId: device.features[0].external_id, state: 40 }]);
});

test('handleSetValue flags an unreachable dimmer and hides the raw driver error', async () => {
  const gladys = createFakeGladys();
  const device = buildDimmer(gladys);
  const tpClient = createFakeTpLink({ byHost: {} }); // nothing answers

  await assert.rejects(
    () => handleSetValue(gladys, tpClient, { device, feature: device.features[1], value: 50 }),
    (err) => {
      assert.match(err.message, /unreachable at 192\.168\.1\.20/);
      assert.doesNotMatch(err.message, /TCP Timeout/);
      return true;
    },
  );
  assert.deepEqual(gladys.transports, [{ external_id: device.external_id, transport: TRANSPORTS.UNREACHABLE }]);
});

// --- poll -------------------------------------------------------------------

test('handlePoll publishes the plug relay_state to its ON/OFF feature', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.10': { ...PLUG_SYSINFO, relay_state: 1 } } });
  const device = buildPlug(gladys);

  await handlePoll(gladys, tpClient, device);

  assert.equal(gladys.published.length, 1);
  assert.equal(gladys.published[0].featureExternalId, device.features[0].external_id);
  assert.equal(gladys.published[0].state, 1);
  assert.deepEqual(gladys.transports, [{ external_id: device.external_id, transport: TRANSPORTS.LOCAL }]);
});

test('handlePoll publishes the bulb light_state.on_off', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.11': { ...BULB_SYSINFO, light_state: { on_off: 1 } } } });
  const device = buildDevice(gladys, BULB_SYSINFO, '192.168.1.11', config).device;

  await handlePoll(gladys, tpClient, device);

  assert.equal(gladys.published[0].featureExternalId, device.features[0].external_id);
  assert.equal(gladys.published[0].state, 1);
});

test('handlePoll does not re-publish an unchanged state', async () => {
  // Gladys does not deduplicate: every published state writes a history row,
  // broadcasts a websocket event and re-evaluates every trigger, against a
  // 300 states/minute budget.
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.10': { ...PLUG_SYSINFO, relay_state: 1 } } });
  const device = buildPlug(gladys);

  await handlePoll(gladys, tpClient, device);
  await handlePoll(gladys, tpClient, device);
  await handlePoll(gladys, tpClient, device);

  assert.equal(gladys.published.length, 1);
  assert.equal(gladys.transports.length, 1); // the transport is deduplicated too
});

test('handlePoll publishes again once the state actually changes', async () => {
  const gladys = createFakeGladys();
  const byHost = { '192.168.1.10': { ...PLUG_SYSINFO, relay_state: 1 } };
  const tpClient = createFakeTpLink({ byHost });
  const device = buildPlug(gladys);

  await handlePoll(gladys, tpClient, device);
  byHost['192.168.1.10'] = { ...PLUG_SYSINFO, relay_state: 0 };
  await handlePoll(gladys, tpClient, device);

  assert.deepEqual(
    gladys.published.map((p) => p.state),
    [1, 0],
  );
});

test('handlePoll refuses to publish the state of another device answering at the address', async () => {
  const gladys = createFakeGladys();
  const device = buildPlug(gladys);
  const tpClient = createFakeTpLink({
    byHost: { '192.168.1.10': { ...PLUG_SYSINFO, deviceId: 'SOMEONE_ELSE', relay_state: 1 } },
  });

  await assert.rejects(() => handlePoll(gladys, tpClient, device), /Another device now answers/);
  assert.equal(gladys.published.length, 0);
});

test('handlePoll flags an unreachable device and hides the raw driver error', async () => {
  const gladys = createFakeGladys();
  const device = buildPlug(gladys);
  const tpClient = createFakeTpLink({ byHost: {} });

  await assert.rejects(
    () => handlePoll(gladys, tpClient, device),
    (err) => {
      assert.match(err.message, /unreachable at 192\.168\.1\.10/);
      assert.doesNotMatch(err.message, /TCP Timeout/);
      return true;
    },
  );
  assert.deepEqual(gladys.transports, [{ external_id: device.external_id, transport: TRANSPORTS.UNREACHABLE }]);
});

test('handlePoll still reports the failure when the unreachable badge cannot be published', async () => {
  const gladys = createFakeGladys();
  const device = buildPlug(gladys);
  const tpClient = createFakeTpLink({ byHost: {} }); // nothing answers
  gladys.failNext('publishTransports');

  await assert.rejects(() => handlePoll(gladys, tpClient, device), /unreachable at 192\.168\.1\.10/);
});

test('handlePoll publishes nothing when the device carries no ON/OFF feature', async () => {
  const gladys = createFakeGladys();
  const device = buildPlug(gladys);
  device.features = [];
  gladys.devices = [device];
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.10': PLUG_SYSINFO } });

  await handlePoll(gladys, tpClient, device);

  assert.equal(gladys.published.length, 0);
});

test('handlePoll publishes nothing when the state cannot be read from the sysinfo', async () => {
  const gladys = createFakeGladys();
  const device = buildPlug(gladys);
  // Same device, but its type is no longer one we know how to read.
  const tpClient = createFakeTpLink({
    byHost: { '192.168.1.10': { deviceId: PLUG_SYSINFO.deviceId, model: 'KC120(EU)', type: 'IOT.IPCAMERA' } },
  });

  await handlePoll(gladys, tpClient, device);

  assert.equal(gladys.published.length, 0);
  assert.deepEqual(gladys.transports, [{ external_id: device.external_id, transport: TRANSPORTS.LOCAL }]);
});

test('handlePoll publishes the brightness next to the on-off state of a dimmer', async () => {
  const gladys = createFakeGladys();
  const tpClient = createFakeTpLink({
    byHost: { '192.168.1.20': { ...DIMMER_SYSINFO, relay_state: 1, brightness: 40 } },
  });
  const device = buildDimmer(gladys);
  const [onOff, brightness] = device.features;

  await handlePoll(gladys, tpClient, device);

  assert.deepEqual(gladys.published, [
    { featureExternalId: onOff.external_id, state: 1 },
    { featureExternalId: brightness.external_id, state: 40 },
  ]);
});

test('handlePoll publishes no brightness for a dimmer discovered before the brightness feature existed', async () => {
  // Legacy device: only the on-off feature, until the next rescan adds the other.
  const gladys = createFakeGladys();
  const legacySysInfo = { ...DIMMER_SYSINFO };
  delete legacySysInfo.brightness;
  const device = buildDevice(gladys, legacySysInfo, '192.168.1.20', config).device;
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.20': DIMMER_SYSINFO } });

  await handlePoll(gladys, tpClient, device);

  assert.deepEqual(gladys.published, [{ featureExternalId: device.features[0].external_id, state: 1 }]);
});

test('handlePoll publishes no brightness when the sysinfo reports none', async () => {
  const gladys = createFakeGladys();
  const device = buildDimmer(gladys);
  const noBrightness = { ...DIMMER_SYSINFO };
  delete noBrightness.brightness;
  const tpClient = createFakeTpLink({ byHost: { '192.168.1.20': noBrightness } });

  await handlePoll(gladys, tpClient, device);

  assert.deepEqual(gladys.published, [{ featureExternalId: device.features[0].external_id, state: 1 }]);
});
