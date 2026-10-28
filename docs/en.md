# TP-Link Kasa

Control your **TP-Link Kasa** smart plugs, switches and bulbs from Gladys, over
your local network. The integration runs in its own container and talks to your
devices using the classic Kasa LAN protocol.

## Supported devices

| Device                 | Feature                                                        |
| ---------------------- | -------------------------------------------------------------- |
| Plugs and switches     | On/Off only (`switch`)                                         |
| Dimmers (HS220, ES20M) | On/Off (`switch`) and brightness slider 1–100 % (`brightness`) |
| Bulbs                  | On/Off (`light`)                                               |

Other TP-Link types are detected during a scan and reported in the logs, but
they are not published because they have no controllable feature yet.

> **Multi-outlet strips are not supported.** Kasa power strips (HS300, HS107,
> KP303, KP400) are detected and deliberately skipped: their outlets are
> controlled individually, which this integration cannot do yet. Publishing them
> would offer a single switch that turns the whole strip off at once.

> **Local-only, legacy protocol.** This integration speaks the classic Kasa LAN
> protocol. Newer Kasa firmware that only exposes the encrypted KLAP protocol is
> not supported.

## How discovery works

Kasa devices only answer an **active discovery probe**, and the integration runs
in a sandboxed container that cannot broadcast onto your LAN. So the scan is
**mediated by Gladys**: the integration forges the encrypted Kasa discovery
request, the Gladys core (which sits on your home network) broadcasts it, and
relays the devices' replies back. You do not enter any IP address — the scan
finds your devices, and the IP each one answered from is remembered to control
it afterwards.

Give your Kasa devices a **DHCP reservation** on your router so their IP address
stays stable; if it changes, a new scan picks up the new address automatically.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Choose a **Refresh interval** — how often each device is polled to refresh
   its state (default: every minute). Save.

   > This interval is stored on each device when it is discovered. Changing it
   > later does **not** update the devices you already created: run a new scan
   > to apply the new value.

3. Open the **Discovery** tab and click **scan**: your Kasa devices appear.
4. Click **create** on the ones you want. They land in the **Devices** tab with
   an On/Off control.

Run a scan again anytime you add a new device.

## Troubleshooting

- **A device does not appear on scan.** Make sure it is powered on and on the
  same network/subnet as your Gladys host, then scan again. Only classic-protocol
  Kasa devices answer (see below).
- **A device appears but never changes state.** Its firmware may only speak the
  newer KLAP protocol, which is not supported.
- **"Nothing happens" when I click scan.** Gladys allows one scan every 10
  seconds: wait a moment before scanning again. The error is shown in the
  integration banner.
- **A device is flagged "unreachable".** It is off, unplugged, or its IP address
  changed. Check it is powered on, then run a new scan to pick up its new
  address.
- **"Another device now answers at this address".** Your router reassigned that
  device's IP address to something else. Run a new scan: the integration
  deliberately refuses to control a device whose identity it could not verify,
  rather than acting on the wrong one.
- **Need more detail?** The integration logs everything it does. Check the
  integration logs from the Gladys UI (or `docker logs` on the host) with
  `LOG_LEVEL=debug` for the full detail.
