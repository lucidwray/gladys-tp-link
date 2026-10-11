// -----------------------------------------------------------------------------
// Resolve the runtime facts a command needs about a device: its IP address and
// its controllable feature.
//
// The device object Gladys hands to onSetValue / onPoll may be lightweight, so
// — like the core, which re-read `gladys.device.get({ service })` — we make sure
// we hold the full device (with `params` and `features`), falling back to
// `gladys.getDevices()` when needed.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { PARAMS } from './constants.js';

/**
 * Read a device param value by name.
 * @param {object} device - A Gladys device.
 * @param {string} name - The param name.
 * @returns {string|undefined} The value, or undefined when absent.
 * @example
 * getParam(device, PARAMS.IP_ADDRESS);
 */
export function getParam(device, name) {
  return device?.params?.find((p) => p.name === name)?.value;
}

/**
 * Ensure we hold the full device (params + features). Falls back to a fresh
 * `gladys.getDevices()` when the passed object is incomplete.
 * @param {object} gladys - The GladysIntegration SDK instance.
 * @param {object} device - The (possibly lightweight) device from an event.
 * @returns {Promise<object>} The fullest device available.
 * @example
 * const full = await resolveDevice(gladys, device);
 */
export async function resolveDevice(gladys, device) {
  const hasParams = Array.isArray(device?.params) && device.params.length > 0;
  const hasFeatures = Array.isArray(device?.features) && device.features.length > 0;
  if (hasParams && hasFeatures) {
    return device;
  }
  const all = await gladys.getDevices();
  return all.find((d) => d.external_id === device.external_id) || device;
}

/**
 * Resolve everything a command needs about a device, in a single lookup: the
 * full device, the address to reach it at, and the serial that address must
 * still be held by.
 * @param {object} gladys - The GladysIntegration SDK instance.
 * @param {object} device - The (possibly lightweight) device from an event.
 * @returns {Promise<{ full: object, host: string, serial: (string|undefined) }>}
 * @throws {Error} When the device carries no IP address param.
 * @example
 * const { full, host, serial } = await resolveTarget(gladys, device);
 */
export async function resolveTarget(gladys, device) {
  const full = await resolveDevice(gladys, device);
  const host = getParam(full, PARAMS.IP_ADDRESS);
  if (!host) {
    const err = new Error('No address stored for this device: run a new scan to find it again');
    err.userFacing = true;
    throw err;
  }
  return { full, host, serial: getParam(full, PARAMS.SERIAL_NUMBER) };
}

/**
 * Find the ON/OFF feature of a TP-Link device (a switch or a light binary).
 * A dimmer's brightness feature is also a switch, so the type must be binary:
 * the first switch alone could return the brightness instead.
 * @param {object} device - A full Gladys device (with features).
 * @returns {object|undefined} The controllable feature, or undefined.
 * @example
 * const feature = findOnOffFeature(full);
 */
export function findOnOffFeature(device) {
  return device?.features?.find(
    (f) =>
      (f.category === DEVICE_FEATURE_CATEGORIES.SWITCH || f.category === DEVICE_FEATURE_CATEGORIES.LIGHT) &&
      (f.type === DEVICE_FEATURE_TYPES.SWITCH.BINARY || f.type === DEVICE_FEATURE_TYPES.LIGHT.BINARY),
  );
}

/**
 * Find the brightness feature of a dimmer plug (a switch with the dimmer type).
 * @param {object} device - A full Gladys device (with features).
 * @returns {object|undefined} The brightness feature, or undefined.
 * @example
 * const feature = findBrightnessFeature(full);
 */
export function findBrightnessFeature(device) {
  return device?.features?.find(
    (f) => f.category === DEVICE_FEATURE_CATEGORIES.SWITCH && f.type === DEVICE_FEATURE_TYPES.SWITCH.DIMMER,
  );
}
