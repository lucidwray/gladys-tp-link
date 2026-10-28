// -----------------------------------------------------------------------------
// Handle a user command on a device feature — port of the core
// `smart-device.setValue.js`.
//
// Only the binary ON/OFF of a plug (switch) or a bulb (light) is controllable,
// exactly like the core, plus the brightness of a dimmer plug (a switch with the
// dimmer type, 1-100). A brightness of 0 turns the dimmer off and keeps its
// level. The command is sent by unicast to the device IP, after checking that
// address is still held by the expected device; the state that is then
// published is the one read back from the device, not the one we asked for, so
// a frame acked but not applied cannot show a state Gladys never saw.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { resolveTarget, findOnOffFeature } from './deviceLookup.js';
import { classify, readOnOff, readBrightness } from './tplink/model.js';
import { publishFeatureState, publishDeviceTransport } from './statePublisher.js';
import { ON, OFF, TRANSPORTS } from './constants.js';
import { toUserFacingError } from './errors.js';

const logger = createLogger({ name: 'tp-link-set-value' });

const CONTROLLABLE_CATEGORIES = [DEVICE_FEATURE_CATEGORIES.SWITCH, DEVICE_FEATURE_CATEGORIES.LIGHT];
const BRIGHTNESS_MIN = 1;
const BRIGHTNESS_MAX = 100;

/**
 * Coerce and validate the requested value of a binary feature.
 * @param {unknown} value - The value Gladys sent.
 * @returns {boolean} True to turn on, false to turn off.
 * @throws {Error} When the value is neither 0 nor 1.
 * @example
 * readRequestedPower('1'); // true
 */
function readRequestedPower(value) {
  // Coerced rather than compared strictly: a '1' coming back as a string would
  // otherwise silently mean OFF, and "turn on" would turn the device off.
  const numeric = Number(value);
  if (numeric !== ON && numeric !== OFF) {
    const err = new Error(`Unsupported value for an On/Off control: ${value}`);
    err.userFacing = true;
    throw err;
  }
  return numeric === ON;
}

/**
 * Coerce and validate the requested brightness of a dimmer. A brightness never
 * turns a dimmer off: the value is rounded, then clamped to 1-100.
 * @param {unknown} value - The value Gladys sent.
 * @returns {number} The integer level, 1 to 100.
 * @throws {Error} When the value is not a number or is NaN.
 * @example
 * readRequestedBrightness('50.4'); // 50
 * readRequestedBrightness(0); // 1
 */
function readRequestedBrightness(value) {
  // Only numbers and numeric strings: '' and null would coerce to 0.
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || Number.isNaN(numeric)) {
    const err = new Error(`Unsupported value for a brightness control: ${value}`);
    err.userFacing = true;
    throw err;
  }
  return Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, Math.round(numeric)));
}

/**
 * Send one command to the device and track its transport: flags the device
 * unreachable on failure, reachable on success.
 * @param {object} gladys - The GladysIntegration SDK instance.
 * @param {object} params - The target.
 * @param {object} params.device - The device from the event.
 * @param {object} params.full - The full device (its external_id is the badge's).
 * @param {string} params.host - The address the command is sent to.
 * @param {Function} send - Sends the command, resolves with the read-back sysinfo.
 * @returns {Promise<object|null>} The read-back sysinfo, or null.
 * @throws {Error} A user-facing error when the command failed.
 * @example
 * const sysInfo = await sendCommand(gladys, { device, full, host }, () => tpClient.setPowerState(host, true));
 */
async function sendCommand(gladys, { device, full, host }, send) {
  let sysInfo;
  try {
    sysInfo = await send();
  } catch (err) {
    logger.error(`Command on ${device.external_id} failed at ${host}`, err);
    await publishDeviceTransport(gladys, full.external_id, TRANSPORTS.UNREACHABLE).catch((reportErr) => {
      logger.error('Could not publish the unreachable transport', reportErr);
    });
    throw toUserFacingError(err, `TP-Link device unreachable at ${host}: check it is powered on and on your network`);
  }

  // Guarded: the command already reached the device, a failed badge update
  // must not hide its new state nor report the command as failed.
  await publishDeviceTransport(gladys, full.external_id, TRANSPORTS.LOCAL).catch((reportErr) => {
    logger.error('Could not publish the local transport', reportErr);
  });
  return sysInfo;
}

/**
 * Apply a brightness to a dimmer: the level, clamped to 1-100, turns it on at
 * that level. A dimmer is turned off only through its on-off feature. Publishes
 * the on-off and brightness states read back from the device.
 * @param {object} gladys - The GladysIntegration SDK instance.
 * @param {object} tpClient - The TP-Link client wrapper.
 * @param {object} params - The command.
 * @param {object} params.device - The target device.
 * @param {object} params.feature - The brightness feature.
 * @param {number} params.value - The requested brightness, clamped to 1-100.
 * @returns {Promise<void>} Resolves once the states have been published.
 * @throws {Error} When the value is not a number or the command failed.
 * @example
 * await handleBrightness(gladys, tpClient, { device, feature, value: 50 });
 */
async function handleBrightness(gladys, tpClient, { device, feature, value }) {
  const level = readRequestedBrightness(value);
  const { full, host, serial } = await resolveTarget(gladys, device);
  const expected = { expectedDeviceId: serial };
  logger.info(`Setting ${device.external_id} -> ${level}% (${host})`);

  const sysInfo = await sendCommand(gladys, { device, full, host }, () =>
    tpClient.setBrightness(host, level, expected),
  );

  // Each state falls back to what was requested when the read-back is missing
  // or unusable, as the on-off path does. A brightness always turns the dimmer on.
  const onOffFeature = findOnOffFeature(full);
  if (onOffFeature) {
    const relay = sysInfo ? readOnOff(classify(sysInfo), sysInfo) : undefined;
    await publishFeatureState(gladys, onOffFeature.external_id, typeof relay === 'number' ? relay : 1);
  }
  await publishFeatureState(gladys, feature.external_id, readBrightness(sysInfo) ?? level);
}

/**
 * Apply a value the user set on a device feature.
 * @param {object} gladys - The GladysIntegration SDK instance.
 * @param {object} tpClient - The TP-Link client wrapper.
 * @param {object} params - The command.
 * @param {object} params.device - The target device.
 * @param {object} params.feature - The target feature.
 * @param {number} params.value - The requested value: 1 = on, 0 = off; for a
 *   dimmer's brightness feature, clamped to 1-100.
 * @returns {Promise<void>} Resolves once the state has been published.
 * @throws {Error} When the feature is not controllable or the command failed.
 * @example
 * await handleSetValue(gladys, tpClient, { device, feature, value: 1 });
 */
export async function handleSetValue(gladys, tpClient, { device, feature, value }) {
  if (!CONTROLLABLE_CATEGORIES.includes(feature.category)) {
    // Throwing makes the SDK ack success:false, so the Gladys UI shows the failure.
    const err = new Error(`This TP-Link device has no On/Off control (${feature.category})`);
    err.userFacing = true;
    throw err;
  }

  if (feature.type === DEVICE_FEATURE_TYPES.SWITCH.DIMMER) {
    return handleBrightness(gladys, tpClient, { device, feature, value });
  }

  const on = readRequestedPower(value);
  const { full, host, serial } = await resolveTarget(gladys, device);
  logger.info(`Setting ${device.external_id} -> ${on ? 'ON' : 'OFF'} (${host})`);

  const sysInfo = await sendCommand(gladys, { device, full, host }, () =>
    tpClient.setPowerState(host, on, { expectedDeviceId: serial }),
  );

  // Publish what the device reports, falling back to the requested value if the
  // read-back is unusable or missing (null: it failed or ran out of time) — the
  // command did succeed, the UI must reflect it.
  const readBack = sysInfo ? readOnOff(classify(sysInfo), sysInfo) : undefined;
  await publishFeatureState(gladys, feature.external_id, typeof readBack === 'number' ? readBack : Number(on));
}
