# AGENTS.md — gladys-tp-link

Project-specific notes. Generic rules live in `CLAUDE.md`, the file map and user-facing behaviour in `README.md`.

## Data flow

- **Scan**: `index.js` `onScanRequest` → `src/discovery.js` `handleScanRequest` → `scan()` calls
  `gladys.scanNetwork('udp-active-broadcast', { port: 9999, payload, timeoutSeconds: 5 })` → each reply is
  decoded by `src/tplink/protocol.js` `parseDiscoveryReply` → deduplicated by `sysInfo.deviceId` (if a device replies
  from two IPs, the last one wins and a warning is logged) → `src/tplink/model.js` `buildDevice` → `publishDiscoveredDevices`.
- **Poll**: `src/poll.js` → `resolveTarget` (`src/deviceLookup.js`) → `tpClient.getSysInfo(host)` →
  `assertExpectedDevice` → publish transport `local`, then publish the ON/OFF state through `src/statePublisher.js`.
- **Command**: `src/setValue.js` → `tpClient.setPowerState(host, on, { expectedDeviceId: serial })` → publish the
  state **read back** from the device. If the read-back is `null` or unreadable, publish the requested value.
- The code never uses the SDK `publishStates` batch, only `publishState` and `publishTransports`.
- There is no persistence: nothing is written under `/data`. The dedup caches in `statePublisher.js` live only in memory.

## Kasa protocol (legacy LAN, not KLAP)

- Discovery uses UDP 9999 with the XOR-autokey cipher from `tplink-smarthome-crypto`. It uses the header-less
  `encrypt`/`decrypt` because the 4-byte length header only exists on TCP. The request is
  `{"system":{"get_sysinfo":{}}}`.
- Control goes over TCP unicast through `tplink-smarthome-api`, which is CommonJS: import the default export and
  destructure it (`src/tplink/client.js`).
- The wrapper sets a 2 s timeout per round-trip (the driver default is 10 s). `setPowerState` takes 3 round-trips
  (identity check, command, read-back) that share a `COMMAND_BUDGET_MS = 4000` budget, to stay inside the 5 s Gladys
  ack window (commit 6a407d0). Passing `sysInfo` to `client.getDevice()` avoids a 4th round-trip.
- Device kind comes from `sysinfo.type`, or the legacy `mic_type` on bulbs. Plug state is `relay_state`, bulb state
  is `light_state.on_off`.
- A power strip (`children[]` present) is detected **before** the plug check because it reports itself as
  `IOT.SMARTPLUGSWITCH`, and it is skipped: a command without a `childId` would switch every outlet. Any other
  unknown type is also skipped, with a log line.
- The scan core returns 429 when scans run less than 10 s apart, and 403 when the capture is missing from the
  manifest `network_discovery`. Both are mapped to `{en, fr}` messages in `SCAN_ERROR_MESSAGES`.

## Identifiers (must stay stable)

- External ids come from `gladys.externalIds(kind, sysInfo.deviceId)`:
  device `ext:<selector>:<kind>:<deviceId>`, feature `ext:<selector>:<kind>:<deviceId>:on-off`.
- `kind` is `plug` or `bulb` (`DEVICE_KINDS` in `src/constants.js`). `power-strip` and `device` exist too but are
  never published.
- Device params `TP_LINK_IP_ADDRESS`, `TP_LINK_SERIAL_NUMBER` and `TP_LINK_MODEL` are the core service's names.
  Polls and commands read the IP and serial back from these params.
- Features: plug → `switch`/`binary` only, bulb → `light`/`binary`. A dimmer (sysinfo `brightness`, HS220/ES20M) also gets a
  `brightness` feature, a switch of the dimmer type (`findBrightnessFeature`). `findOnOffFeature` finds the feature by category
  (switch or light), not by its external id.
- The only config key is `poll_frequency`, in seconds, stored as a string by the select. It is written onto the device
  as `poll_frequency * 1000` ms. Core accepts only 1/2/10/15/30/60 s, and any other value makes
  `publishDiscoveredDevices` fail silently (1.0.1 fix). `normalizeConfig` snaps values to the nearest allowed one
  (ties go to the larger value). NaN, non-numbers, booleans and `null` fall back to 60, never to 1.

## Gotchas

- `onScanRequest` and `onConfigUpdated` are **unacked**: the SDK swallows anything they throw. `handleScanRequest`
  must never throw, and it reports through `setConnectionStatus(false, {en, fr})`. Keep the `.catch()` on reporting calls.
- `onSetValue`/`onPoll` throw to ack a failure. The ack carries a plain string (no i18n), so raw driver errors
  (multi-line, with protocol JSON) are replaced by `toUserFacingError` (`src/errors.js`). Errors the code raises on
  purpose set `err.userFacing = true` and are kept verbatim.
- DHCP safety: before every read or command, `assertExpectedDevice` checks that the serial matches, so a reassigned IP
  cannot act on the wrong device. The fix is to rescan, which upserts the IP param.
- `statePublisher.js` deduplicates by value because Gladys stores history, fires triggers and applies a 300/min
  limit on every publish. It also drops a poll read (`readAt`) that is older than the last publish, so a poll that
  started before a command cannot flip the UI back. The cache entry is written before the `await` and rolled back
  if the publish fails (commit 023fcd0).
- A failed read or command publishes transport `unreachable`, and the next success publishes `local`. Both are
  deduplicated.
- `src/lifecycle.js`: when the first `connect()` fails, the code only logs it and does not exit, because the SDK
  keeps retrying (b50f494). An unhandled rejection logs its reason and then exits with code 1 (fb054a0).
- `Number(value)` coercion in `setValue.js` is deliberate: a string `'1'` must not mean OFF.
- `index.js` does not rescan on reconnect. Devices keep working from their stored IP.

## Tests

- `test/helpers/fakeGladys.js` fakes the SDK surface. Its `externalIds` returns `ext:test:…`; `failNext(method, n)`
  makes the next n `publishState`/`publishTransports` calls fail with 429.
- `test/helpers/fakeTpLink.js` fakes the client wrapper and provides the `PLUG_/BULB_/UNKNOWN_/POWER_STRIP_SYSINFO`
  fixtures. `discoveryReply(ip, sysInfo)` builds a really encrypted scan reply, so the codec is exercised for real.
- `test/client.test.js` injects a fake driver with a fake clock (`now`) to check round-trip counts and the time
  budget. It also starts a real TCP fake Kasa device on localhost for the real driver.
- Call `resetPublishedState()` in `beforeEach` because the dedup caches are module-level.
- `test/manifest.test.js` checks that the manifest agrees with the code: port 9999, the poll_frequency options match
  the accepted set, the default matches `DEFAULT_CONFIG`, and the version matches `package.json` and the image tag.
- `npm run coverage` enforces lines 95 / branches 90 / functions 85 and needs Node ≥ 22.8.
