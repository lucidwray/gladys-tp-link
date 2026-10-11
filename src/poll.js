// -----------------------------------------------------------------------------
// Refresh a device state on Gladys' schedule — port of the core
// `smart-device.poll.js`.
//
// Read the current sysinfo by unicast, check the address is still held by the
// device we expect, extract the ON/OFF state depending on the device kind (plug
// -> relay_state, bulb -> light_state.on_off) and publish it if it changed.
//
// Publishing an unchanged value is NOT free: Gladys writes a history row,
// broadcasts a websocket event and re-evaluates every trigger on each state it
// receives — hence the deduplication in src/statePublisher.js.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { resolveTarget, findOnOffFeature, findBrightnessFeature } from './deviceLookup.js';
import { classify, readOnOff, readBrightness, assertExpectedDevice } from './tplink/model.js';
import { publishFeatureState, publishDeviceTransport } from './statePublisher.js';
import { TRANSPORTS } from './constants.js';
import { toUserFacingError } from './errors.js';

const logger = createLogger({ name: 'tp-link-poll' });

/**
 * Poll a device and publish its current ON/OFF state.
 * @param {object} gladys - The GladysIntegration SDK instance.
 * @param {object} tpClient - The TP-Link client wrapper.
 * @param {object} device - The device to poll.
 * @returns {Promise<void>} Resolves once the state has been published.
 * @throws {Error} When the device cannot be read, so the SDK acks the failure.
 * @example
 * await handlePoll(gladys, tpClient, device);
 */
export async function handlePoll(gladys, tpClient, device) {
  const { full, host, serial } = await resolveTarget(gladys, device);

  const feature = findOnOffFeature(full);
  if (!feature) {
    logger.warn(`Poll: no ON/OFF feature found for ${device.external_id}`);
    return;
  }

  // Taken before the read so a poll that started before a user command cannot
  // publish the pre-command state after it (see src/statePublisher.js).
  const readAt = Date.now();
  let sysInfo;
  try {
    sysInfo = await tpClient.getSysInfo(host);
    assertExpectedDevice(sysInfo, serial, host);
  } catch (err) {
    logger.error(`Poll of ${device.external_id} failed at ${host}`, err);
    await publishDeviceTransport(gladys, full.external_id, TRANSPORTS.UNREACHABLE).catch((reportErr) => {
      logger.error('Could not publish the unreachable transport', reportErr);
    });
    throw toUserFacingError(err, `TP-Link device unreachable at ${host}: check it is powered on and on your network`);
  }

  await publishDeviceTransport(gladys, full.external_id, TRANSPORTS.LOCAL);

  const state = readOnOff(classify(sysInfo), sysInfo);
  if (typeof state !== 'number') {
    logger.warn(`Poll: no readable ON/OFF state for ${device.external_id} (model ${sysInfo.model})`);
    return;
  }

  logger.debug(`Poll ${device.external_id} -> ${state} (${host})`);
  await publishFeatureState(gladys, feature.external_id, state, readAt);

  // A device discovered before dimmers were supported has no brightness feature
  // yet (it appears after a rescan): nothing to publish to, so nothing is.
  const brightnessFeature = findBrightnessFeature(full);
  const brightness = readBrightness(sysInfo);
  if (brightnessFeature && brightness !== undefined) {
    await publishFeatureState(gladys, brightnessFeature.external_id, brightness, readAt);
  }
}
