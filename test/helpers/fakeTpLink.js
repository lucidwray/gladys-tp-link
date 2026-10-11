// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the TP-Link client wrapper (src/tplink/client.js).
//
//   - getSysInfo(host)            -> returns the sysinfo mapped to that host, or throws
//   - setPowerState(host,on)      -> records the command
//   - setBrightness(host,level)   -> records the level, and the power-on the real
//                                    client sends when the dimmer was off
//
// Also provides discoveryReply(): a real encrypted `udp-active-broadcast` scan
// result for a sysinfo, so discovery tests exercise the actual codec.
// -----------------------------------------------------------------------------

import { encrypt } from 'tplink-smarthome-crypto';
import { assertExpectedDevice } from '../../src/tplink/model.js';

/**
 * Build a raw scan reply the way the core relays it, with a genuinely encrypted
 * Kasa payload — so parseDiscoveryReply() is exercised for real.
 * @param {string} sourceIp - The device IP the reply comes from.
 * @param {object} sysInfo - The TP-Link `sysinfo` to encode.
 * @returns {{ source_ip: string, source_port: number, payload_base64: string }}
 * @example
 * discoveryReply('192.168.1.10', PLUG_SYSINFO);
 */
export function discoveryReply(sourceIp, sysInfo) {
  const payload = encrypt(JSON.stringify({ system: { get_sysinfo: sysInfo } }));
  return { source_ip: sourceIp, source_port: 9999, payload_base64: payload.toString('base64') };
}

export function createFakeTpLink({ byHost = {} } = {}) {
  const powerCommands = [];
  const brightnessCommands = [];

  function read(host) {
    const sysInfo = byHost[host];
    if (!sysInfo) {
      // Shaped like the driver's own failure: multi-line, with the protocol
      // payload — exactly what must never reach the user (see src/errors.js).
      throw new Error(`TCP Timeout after 2000ms\n${host}:9999 {"system":{"get_sysinfo":{}}}`);
    }
    return sysInfo;
  }

  return {
    powerCommands,
    brightnessCommands,

    async getSysInfo(host) {
      return read(host);
    },

    async setPowerState(host, on, { expectedDeviceId } = {}) {
      const sysInfo = read(host);
      assertExpectedDevice(sysInfo, expectedDeviceId, host);
      powerCommands.push({ host, on });
      // The real wrapper reads the state back after commanding it.
      return sysInfo.light_state
        ? { ...sysInfo, light_state: { ...sysInfo.light_state, on_off: on ? 1 : 0 } }
        : { ...sysInfo, relay_state: on ? 1 : 0 };
    },

    async setBrightness(host, level, { expectedDeviceId } = {}) {
      const sysInfo = read(host);
      assertExpectedDevice(sysInfo, expectedDeviceId, host);
      brightnessCommands.push({ host, level });
      if (sysInfo.relay_state === 0) {
        powerCommands.push({ host, on: true });
      }
      return { ...sysInfo, brightness: level, relay_state: 1 };
    },
  };
}

// Handy sysinfo fixtures matching real TP-Link Kasa responses.
export const PLUG_SYSINFO = {
  deviceId: 'PLUG0001',
  alias: 'Office plug',
  model: 'HS100(EU)',
  type: 'IOT.SMARTPLUGSWITCH',
  relay_state: 1,
};

// A dimmer plug (HS220, ES20M): a plug that also reports a brightness.
export const DIMMER_SYSINFO = {
  deviceId: 'DIMMER0001',
  alias: 'Kitchen dimmer',
  model: 'HS220(US)',
  type: 'IOT.SMARTPLUGSWITCH',
  relay_state: 1,
  brightness: 60,
};

export const BULB_SYSINFO = {
  deviceId: 'BULB0001',
  alias: 'Desk bulb',
  model: 'LB100(EU)',
  mic_type: 'IOT.SMARTBULB',
  light_state: { on_off: 0 },
};

export const UNKNOWN_SYSINFO = {
  deviceId: 'CAM0001',
  alias: 'Front camera',
  model: 'KC120(EU)',
  type: 'IOT.IPCAMERA',
};

// Multi-outlet strip: announced as a plug type, but its state lives in
// `children[]` — must be detected and skipped, not published as a plug.
export const POWER_STRIP_SYSINFO = {
  deviceId: 'STRIP001',
  alias: 'Desk strip',
  model: 'HS300(US)',
  type: 'IOT.SMARTPLUGSWITCH',
  children: [
    { id: 'STRIP00100', alias: 'Outlet 1', state: 1 },
    { id: 'STRIP00101', alias: 'Outlet 2', state: 0 },
  ],
};
