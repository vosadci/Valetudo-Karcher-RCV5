# Valetudo on this robot — quick reference

This is a copy of the essentials, kept on the robot itself for anyone with
only SSH access — no laptop, no checkout of this repo. It is deliberately
short. For full detail (protocol writeups, build steps, troubleshooting),
see `README.md` in the `contrib/karcher-rcv5/` directory of the repo this
was deployed from: https://github.com/vosadci/Valetudo-Karcher-RCV5

## Start here

```sh
/userdata/valetudo/manage.sh
```

Run with no arguments (or `help`), it prints live status plus exactly which
command to run next. It's self-documenting on purpose — this file is just a
backup for when even that feels like too much.

Subcommands: `status`, `activate`, `deactivate`, `wifi [ssid]`,
`uninstall [--purge]`.

## What's installed where

- `/userdata/valetudo/` — Valetudo binary, wrapper scripts (`manage.sh`,
  `karcher-cloud-switch.sh`, `aiot-gate.sh`, `S96valetudo`), dev TLS cert/key.
- `/userdata/cfg/rockchip_test/auto_reboot.sh` — boot-autostart hook (sourced
  by the vendor's own `S99_auto_reboot`), with a durable backup copy at
  `/userdata/valetudo/auto_reboot.sh` in case a reset ever clears the first.
- Backups of anything this tooling ever overwrote live under `/userdata/` as
  `*.orig` files — never deleted, even by `uninstall.sh --purge`.

## Common tasks

**Check current state:** `manage.sh status`

**Switch into/out of Valetudo mode:** `manage.sh activate` /
`manage.sh deactivate` (deactivate returns the robot to the real Kärcher
cloud without removing anything, so it's always safe to try).

**Lost WiFi / robot not reachable from the app:**
`manage.sh wifi [ssid]` — prompts for the password, stages the new network,
verifies it actually connects before saving, and falls back to the previous
config if it doesn't. Works the same over `ssh` or `adb shell`.

**Fully remove Valetudo:** `manage.sh uninstall --purge` — switches back to
stock cloud mode first and refuses to purge if that fails, so a bad
cert/hosts state is never left behind without its recovery tools.

## Firmware

This tooling is anchored to firmware `I3.12.90` specifically and may
silently misbehave on a different build — check with
`cat /oem/sysconf/sysVersion.ini`.

There is a fully-mapped (by disassembly, never live-tested) local trigger
for the vendor's own OTA daemon, but it is **on hold**: no known way exists
yet to revert this robot's firmware first, so there is no confirmed way back
from a failed attempt. Don't try it. Full writeup: repo `README.md`,
"Local OTA trigger (on hold, not tested)".

## If something looks wrong

`manage.sh status` shows `karcher-cloud-switch.sh status` and
`aiot-gate.sh status` output directly — run those two commands by hand for
more detail than the summary gives. Both are idempotent and safe to re-run.
