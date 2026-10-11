// -----------------------------------------------------------------------------
// Map a TP-Link `sysinfo` object to a Gladys discovery payload.
//
// Direct port of the core models (server/services/tp-link/lib/models):
//   - IOT.SMARTPLUGSWITCH / IOT.RANGEEXTENDER.SMARTPLUG -> plug  (SWITCH/binary)
//   - IOT.SMARTBULB                                     -> bulb  (LIGHT/binary)
//   - a `children[]` strip                              -> unsupported (skipped)
//   - anything else                                     -> unsupported (skipped)
//
// The external ids are built with the SDK so they are namespaced with the
// integration selector; the IP address and serial number ride along as device
// `params`, the way the core carried TP_LINK_IP_ADDRESS / SERIAL_NUMBER.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_KINDS, FEATURE_KEYS, PARAMS, TP_LINK_DEVICE_TYPES } from '../constants.js';

/**
 * Classify a TP-Link device from its system info.
 * @param {object} sysInfo - The TP-Link `sysinfo` object.
 * @returns {string} One of DEVICE_KINDS (plug | bulb | power-strip | device).
 * @example
 * classify({ type: 'IOT.SMARTPLUGSWITCH' }); // 'plug'
 */
export function classify(sysInfo) {
  const type = sysInfo.type || sysInfo.mic_type;
  // Checked before the plug test: a strip announces itself as a plug type.
  if (Array.isArray(sysInfo.children) && sysInfo.children.length > 0) {
    return DEVICE_KINDS.POWER_STRIP;
  }
  if (TP_LINK_DEVICE_TYPES.PLUG.includes(type)) {
    return DEVICE_KINDS.PLUG;
  }
  if (TP_LINK_DEVICE_TYPES.BULB.includes(type)) {
    return DEVICE_KINDS.BULB;
  }
  return DEVICE_KINDS.UNKNOWN;
}

/**
 * Read the ON/OFF state out of a sysinfo, given the device kind.
 * @param {string} kind - One of DEVICE_KINDS.
 * @param {object} sysInfo - The TP-Link `sysinfo` object.
 * @returns {number|undefined} 1 / 0, or undefined for an unsupported kind.
 * @example
 * readOnOff(DEVICE_KINDS.PLUG, { relay_state: 1 }); // 1
 */
export function readOnOff(kind, sysInfo) {
  if (kind === DEVICE_KINDS.PLUG) {
    return sysInfo.relay_state;
  }
  if (kind === DEVICE_KINDS.BULB) {
    return sysInfo.light_state?.on_off;
  }
  return undefined;
}

/**
 * Read the brightness out of a sysinfo, when the device reports one (dimmers).
 * @param {object} sysInfo - The TP-Link `sysinfo` object.
 * @returns {number|undefined} The brightness (0-100), or undefined when absent.
 * @example
 * readBrightness({ brightness: 60 }); // 60
 */
export function readBrightness(sysInfo) {
  return Number.isFinite(sysInfo?.brightness) ? sysInfo.brightness : undefined;
}

/**
 * Check that the device answering at an address is the one we stored.
 *
 * Kasa devices are reached by IP, but an IP is only a lease: once it is
 * reassigned, reading a state would publish another device's value, and a
 * command would switch the wrong device. The serial is the stable identity, so
 * it is verified before anything is read or written.
 * @param {object} sysInfo - The `sysinfo` just read from the address.
 * @param {string} [expectedDeviceId] - The serial stored on the Gladys device.
 * @param {string} host - The address that answered, for the error message.
 * @returns {void}
 * @throws {Error} When the address is held by a different device.
 * @example
 * assertExpectedDevice(sysInfo, 'PLUG0001', '192.168.1.10');
 */
export function assertExpectedDevice(sysInfo, expectedDeviceId, host) {
  if (expectedDeviceId && sysInfo?.deviceId !== expectedDeviceId) {
    const err = new Error(`Another device now answers at ${host}: run a new scan to refresh the addresses`);
    err.userFacing = true;
    throw err;
  }
}

/**
 * Build the Gladys discovery payload for one TP-Link device.
 * @param {object} gladys - The GladysIntegration SDK instance.
 * @param {object} sysInfo - The TP-Link `sysinfo` object.
 * @param {string} host - The device IP address.
 * @param {object} config - The normalized integration configuration.
 * @returns {{ kind: string, device: (object|null) }} The kind and the payload
 *   (null for an unsupported device, so the caller can skip it).
 * @example
 * buildDevice(gladys, sysInfo, '192.168.1.10', config);
 */
export function buildDevice(gladys, sysInfo, host, config) {
  const kind = classify(sysInfo);
  const ids = gladys.externalIds(kind, sysInfo.deviceId);
  const alias = sysInfo.alias || sysInfo.dev_name || `TP-Link ${sysInfo.deviceId}`;

  const device = {
    name: alias,
    external_id: ids.device,
    // Gladys core only accepts a poll_frequency in milliseconds, from a closed
    // set (1/2/10/15/30/60s) — config.poll_frequency is validated against that
    // same set, in seconds (see src/config.js).
    poll_frequency: config.poll_frequency * 1000,
    params: [
      { name: PARAMS.IP_ADDRESS, value: host },
      { name: PARAMS.SERIAL_NUMBER, value: sysInfo.deviceId },
      { name: PARAMS.MODEL, value: sysInfo.model || '' },
    ],
    features: [],
  };

  if (kind === DEVICE_KINDS.PLUG) {
    device.features.push({
      name: `${alias} On/Off`,
      external_id: ids.feature(FEATURE_KEYS.ON_OFF),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    });
    // Only a dimmer reports a brightness: plugs without one keep their single feature.
    if (readBrightness(sysInfo) !== undefined) {
      device.features.push({
        name: `${alias} Brightness`,
        external_id: ids.feature(FEATURE_KEYS.BRIGHTNESS),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.DIMMER,
        min: 1,
        max: 100,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      });
    }
    return { kind, device };
  }

  if (kind === DEVICE_KINDS.BULB) {
    device.features.push({
      name: `${alias} On/Off`,
      external_id: ids.feature(FEATURE_KEYS.ON_OFF),
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    });
    return { kind, device };
  }

  // Unsupported device type: no controllable feature, so nothing to publish.
  return { kind, device: null };
}
