// -----------------------------------------------------------------------------
// Integration-wide constants.
//
// Ported from the Gladys core `tp-link` service (server/services/tp-link), then
// adapted to the external-integration model: external ids are now built with
// the SDK (`gladys.externalIds(type, platformId)`) so they are namespaced with
// the integration selector, and the physical IP / serial are carried as device
// `params` — exactly like the core stored TP_LINK_IP_ADDRESS / SERIAL_NUMBER.
// -----------------------------------------------------------------------------

// `type` segment used by `gladys.externalIds(type, deviceId)`. Kept short and
// stable: it is baked into every device/feature external_id.
export const DEVICE_KINDS = {
  PLUG: 'plug',
  BULB: 'bulb',
  // Multi-outlet strips (HS300, HS107, KP303, KP400): announced as
  // IOT.SMARTPLUGSWITCH like a single plug, but their state lives in
  // `sysinfo.children[]` and a command without a childId switches every outlet
  // at once. Detected on purpose so they are skipped with a clear message
  // instead of being published as a plug that cannot work.
  POWER_STRIP: 'power-strip',
  UNKNOWN: 'device',
};

// Feature key (last segment of the feature external_id). A Kasa plug/bulb here
// exposes a controllable ON/OFF feature; a dimmer plug (HS220, ES20M) also
// exposes a BRIGHTNESS feature, added at discovery when sysinfo reports one.
export const FEATURE_KEYS = {
  ON_OFF: 'on-off',
  BRIGHTNESS: 'brightness',
};

// Device param names — same names the core used, so the concept maps 1:1.
export const PARAMS = {
  IP_ADDRESS: 'TP_LINK_IP_ADDRESS',
  SERIAL_NUMBER: 'TP_LINK_SERIAL_NUMBER',
  MODEL: 'TP_LINK_MODEL',
};

// TP-Link `sysinfo.type` (or legacy `mic_type`) values, mapped to a kind.
export const TP_LINK_DEVICE_TYPES = {
  PLUG: ['IOT.SMARTPLUGSWITCH', 'IOT.RANGEEXTENDER.SMARTPLUG'],
  BULB: ['IOT.SMARTBULB'],
};

// setPowerState() expects a boolean; keep the on/off numeric convention of
// Gladys (1 = on, 0 = off) at the edges only.
export const ON = 1;
export const OFF = 0;

// Per-device transport badge published with `gladys.publishTransports()`. This
// integration only speaks to the LAN, so a device is either reachable there or
// not reachable at all.
export const TRANSPORTS = {
  LOCAL: 'local',
  UNREACHABLE: 'unreachable',
};
