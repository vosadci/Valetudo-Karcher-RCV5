# Kärcher RCV5 Valetudo provisioning

Tooling to build a custom Valetudo vendor module for the Kärcher RCV5 
and set it up (or fully revert it) on a freshly-rooted robot. 
The scripts here are tracked in git; the files they generate
(dev TLS cert/key, the off-device backup mirror, captured test maps) are
gitignored — see `.gitignore` for the exact list.

This directory does **not** cover rooting the robot itself — that's a
separate, robot-specific exploit you need root SSH access from before
starting here.

## Disclaimer — read this first

**Use everything here entirely at your own risk.** This is an unofficial,
community effort. It is **not** affiliated with, endorsed by, or supported by
Kärcher or Valetudo's maintainer. There is **no warranty** of any kind and no
promise that any of it works on your robot.

- **It can break, soft-brick, or permanently damage your robot.** You are
  modifying a rooted device at a low level — writing certs into `/oem`,
  patching boot scripts, redirecting the robot's cloud, and (optionally)
  touching firmware. A mistake, a power loss at the wrong moment, a vendor
  update, or a firmware mismatch can leave the robot unbootable or unusable.
- **There is no confirmed way back to stock firmware.** The robot has an A/B
  slot layout (`system_a`/`system_b`) — the recessed button's long-hold can
  switch slots, and that's a real firmware change, but it only *surfaces*
  whatever happens to already be sitting in the other slot. There's no
  separate protected/golden copy, and ordinary vendor OTAs freely overwrite
  either slot. On a robot that's been updated more than once, both slots are
  typically already the same (current) build, so the switch is a no-op. The
  other four reset mechanisms (app factory reset, "privacy/withdraw consent",
  both-buttons, "reset and remove robot") never touch firmware at all — only
  `/userdata/config|log|cfg`. See "Disaster recovery" below for how to check
  each slot's build before relying on this. The firmware-update tooling here
  is **unfinished and untested**; treat it as reference only.
- **Rooting and running custom software almost certainly voids your warranty**
  and may violate the device's terms of use. That's your call to make.
- This tooling targets exactly one firmware (`I3.12.90`) and one model. On
  anything else it will refuse to run or misbehave silently.
- Back up the irreplaceable files (see "Irreplaceable files" below) before you
  start, and keep them safe — after a `/userdata` wipe they are the only
  record of the robot's pre-Valetudo state.

If you are not comfortable recovering a robot over a serial console or USB
when something goes wrong, stop here.

## Security — this robot is wide open, by design and otherwise

A rooted RCV5 running this tooling has **several unauthenticated attack
surfaces on the local network**. Assume that anyone with access to the robot's
LAN (or Wi-Fi) can take it over completely. Treat the robot's network as
trusted, keep it off guest/IoT-hostile networks you don't control, and enable
every mitigation below.

- **Unauthenticated root ADB over the LAN (port 5555) and USB.** Once the
  device is rooted (`/userdata/debug_mode` present), `adbd` runs with **no
  authentication** — no RSA pairing, no password. It is reachable both over the
  internal USB-OTG port **and over the network on TCP port 5555** (confirmed),
  so anyone on the LAN can `adb connect <robot-ip>:5555` and get a **root
  shell**. On a rooted unit, LAN access ≈ full root. There is no built-in way
  to firewall it (the kernel has no netfilter).
- **Root SSH with a default, well-known password.** `sshd` is gated by the same
  `debug_mode` flag and accepts the vendor's **default root password**, which
  is public. `/root` is read-only squashfs, so you can't add key-only auth or
  change the password there. Anyone on the LAN who knows the default password
  has a root shell.
- **Valetudo's web UI has no authentication by default.** Until you turn it on
  (Settings → … → turn on basic auth), anyone on the LAN can open
  `http://<ROBOT_IP>` and fully control the robot. **Enable it.** Note it is
  only HTTP basic auth, and CSRF/Host-header protections are minimal.
- **The web UI's HTTPS option uses a self-signed cert.** The opt-in HTTPS quirk
  (port 8443) encrypts traffic — most usefully the basic-auth password — but
  the cert is self-signed, so it gives **privacy, not a verified identity**
  (the browser warns once; you can't tell a MITM from the real robot by the
  cert alone). Plain HTTP on port 80 stays open alongside it.
- **The camera stream is open to the whole LAN while it runs.** When the camera
  is on and someone is watching, the demo encoder's RTSP server on port 554
  listens on every interface with **no login**, and there's no firewall to
  close it. Keep the camera quirk off when not in use. See "The Kärcher UI"
  below for detail.
- **The Wi-Fi onboarding AP is open (no password).** The two-top-buttons flow
  brings up an **open** access point for ~10 minutes; anyone nearby can join it
  and reconfigure the robot's Wi-Fi during that window. See "Configuring Wi-Fi
  via the robot's own AP" below.
- **Rooting persists until you remove it — a reset won't.** `debug_mode` (and
  therefore ADB/SSH) survives every reset mechanism tested, so it does **not**
  clear itself. You *can* un-root deliberately: `./uninstall.sh <robot-ip>
  --purge` to revert this tooling, then delete `/userdata/debug_mode`
  (`ssh root@<robot-ip> rm -f /userdata/debug_mode`) and reboot — `adbd`/`sshd`
  then no longer start, closing the root-ADB and root-SSH surfaces. (This is
  separate from the robot's *firmware*, which has no confirmed revert path — see
  the disclaimer.)
- **The hosts-file block is not enough on its own. Block the robot's internet
  access on your router.** In valetudo mode `karcher-cloud-switch.sh` points the
  robot's known cloud hosts at loopback, on top of the main dummycloud redirect.
  That list is hand-built, and it has already missed something real: until
  2026-10-03, `log-server` kept uploading device logs and raw SLAM map data to
  Alibaba Cloud in Shenzhen (`aiot-devlog-prod.oss-cn-shenzhen.aliyuncs.com`)
  in valetudo mode, using an access key built into the firmware. That host is
  blocked now. The binaries also contain hardcoded IP addresses, which no hosts
  file can stop, and the kernel has no firewall. Valetudo needs no internet, so
  give the robot LAN-only access on your router. **Before you do, set Valetudo's
  NTP server to the IP address of an NTP server on your LAN.** `aiot_client` won't
  connect to Valetudo until its own time check succeeds, and that check uses
  hardcoded internet NTP hosts. `karcher-cloud-switch.sh valetudo` points them at
  Valetudo's NTP server, but only when it's set as an IP address. Without this, a
  WAN block leaves Valetudo with no map, no settings and `cannot publish, no MQTT
  client connected` errors. See "Known limitations" below.

**Minimum hardening:** enable Valetudo basic auth, turn on the HTTPS quirk,
keep the camera off unless you're using it, remove `/userdata/debug_mode` if
you don't need ADB/SSH (this closes the root-ADB-over-LAN and root-SSH surfaces
— re-create it when you need them back), and run the robot only on a network
you control. On that network, block the robot from the internet entirely.

## Prerequisites

- **Root SSH access to the robot**, obtained separately (out of scope of
  this directory). Password-based: `/root` sits on read-only squashfs, so
  key-based auth can't be set up there — every script below prompts for the
  root password once per run (see "Repeated password prompts" below for why
  it's only once).
- **Node.js ≥ 20** (`node -v`) and **npm** — for building Valetudo itself.
- **Python 3** with the `cryptography` package (`pip install cryptography`)
  — for generating the dev TLS certificate.
- `ssh`/`scp` (already on macOS/Linux by default).
- The robot's current LAN IP (if DHCP-assigned, can change — confirm it before
  running anything if it's been a while).

## Getting the code

Clone the fork — **not** upstream `Hypfer/Valetudo`, which has no Kärcher
module:

```sh
git clone git@github.com:vosadci/Valetudo-Karcher-RCV5.git
cd Valetudo-Karcher-RCV5
```

Every command below runs on your Mac/PC — not on the robot. Each section
states explicitly which directory it runs from: the repo root for `npm`/build
commands, `contrib/karcher-rcv5/` (inside that checkout) for everything else.

## Installing dependencies

From the repo root:

```sh
npm ci
```

This installs all three workspaces (`backend`, `frontend`, `docs`). Node ≥ 20 is only for
building on your machine; the robot runs the Node 22 runtime that `pkg` embeds in the binary.

## Generating the dev TLS certificate

Kärcher's `aiot_client` on the robot only trusts a specific, oddly-shaped
certificate (a genuine ASN.1 v1 cert — `gen_cert.py` first builds a normal
v3 cert, since that's all `cryptography` can emit, then strips the version
field from the DER by hand, because a v3 cert gets rejected by its mbedTLS
stack). Nothing here is extracted from the Kärcher app; it's a self-signed
cert generated fresh on your machine, impersonating `*.3irobotix.net`
purely so `aiot_client` accepts the handshake with your local Valetudo
instance instead of the real cloud.

From `contrib/karcher-rcv5/`:

```sh
python3 gen_cert.py
```

Safe to re-run: it's a no-op if `server.key`, `server.crt`, 
`server_v1.crt`, and `server_v1.der` already exist, and only ever writes 
all four together (via temp files + atomic rename), so an interrupted run 
can never leave a mismatched key/cert pair behind. Pass `--force` to 
regenerate deliberately. `install.sh` (below) pushes `server_v1.crt` and 
`server.key` to the robot; `server.crt`/`server_v1.der` are intermediates 
you can ignore afterward.

You do **not** need to extract anything from the Kärcher app for this step.
The third cert the robot needs, `gdroot-g2.crt`, is *not* generated here —
it's the robot's own real CA bundle, pulled off the device itself by
`install.sh` during its backup step.

## Building the Valetudo binary

From anywhere in the repo:

```sh
contrib/karcher-rcv5/build.sh
```

This runs three steps in order (it is safe to run them by hand from the repo
root instead). Between steps 2 and 3 it also checks that `frontend/build/index.html` and
`frontend/build/karcher-ui/index.html` exist, and stops if either is missing:

```sh
npm run build --workspace=frontend      # Valetudo's own web UI
node contrib/karcher-rcv5/webui/build.js # the Kärcher UI, served at /karcher-ui/
npm run build_armv7 --workspace=backend  # the armv7 binary embedding both
```

The order matters. `backend/package.json`'s `pkg` config bundles
`../frontend/build` as an asset, and `WebServer.js` serves that directory
as the web UI, so both UIs must already be in it. The Kärcher UI builds into
`frontend/build/karcher-ui/`, and the frontend build wipes `frontend/build`
first, so it has to come after it. Skipping step 2 still produces a working
binary, just without `/karcher-ui/`. The last step regenerates the Kärcher
protobufs, then compiles the actual ~34MB static armv7 binary via `pkg` to
`build/armv7/valetudo`.

The first time you run the `pkg` step, it downloads a prebuilt Node runtime
for `node22-linuxstatic-armv7` (tens of MB) into `build_dependencies/` —
this needs network access and can take a few minutes; it looks like a hang
but isn't. Subsequent builds reuse the cached download.

Confirm the binary exists before continuing (still from the repo root):

```sh
ls -la build/armv7/valetudo
```

## Installing on the robot

From `contrib/karcher-rcv5/`. Replace `<robot-ip>` below with your robot's
actual LAN IP throughout (e.g. `192.168.1.42`).

**1. Stage everything.** Pushes the Valetudo binary, wrapper scripts, dev
certs, and the boot-autostart hook; takes a backup of the robot's original
files. The robot is left **fully stock** afterward — nothing is redirected
yet.

```sh
./install.sh <robot-ip>
```

Before touching anything else, this checks the robot's firmware
(`/oem/sysconf/sysVersion.ini`) against the exact version this tooling was
built against (`I3.12.90`) and refuses to proceed on a mismatch, printing
both versions. This tooling — `aiot-gate.sh`'s `wifi-deamon.sh` patch above
all — is anchored to that specific firmware and will refuse or silently
misbehave on another build; a factory reset or a vendor update can revert or
change it without warning, so this is checked on every run, not just the
first. If it mismatches, see "Updating firmware" below. That tooling is
**unfinished and untested — informational only, use at your own risk.**

You'll be asked for the root password once (subsequent `ssh`/`scp` calls in
the same run, and any other script run within 10 minutes, reuse that
connection — see `lib.sh`). Expect output ending in:

```
install.sh complete. Robot is still in stock/cloud mode — nothing has been redirected.
Run ./activate.sh <robot-ip> when you're ready to switch it into valetudo mode.
```

Safe to re-run any time (e.g. after rebuilding the binary) — it never
touches `config.json`, `device-identity.json`, or the current mode, only the
binary/scripts/certs.

If it fails partway (e.g. dropped connection during the 34MB binary push),
just run it again.

**2. Activate.** Switches the robot's `aiot_client`/`RobotApp` onto the
local Valetudo dummycloud and persists that choice so it survives a reboot.

```sh
./activate.sh <robot-ip>
```

The very first time you run this against a given robot (or any time after
`aiot-gate.sh overlay off` or a factory reset), it also arms the `/oem`
overlay it needs to write certs there and reboots the robot automatically —
expect this run to take a minute or two longer than usual while it waits for
the robot to come back up. Every run after that is fast, no reboot.

Before switching the robot into valetudo mode, this also patches
`wifi-deamon.sh` on the robot (`aiot-gate.sh patch`, idempotent) so
`aiot_client` can't launch at all until the local dummycloud redirect is
verified — closing the boot-time window where it could otherwise still
briefly reach the real 3irobotix cloud (`aiot_client` is launched by
`wifi-deamon.sh`'s watchdog ~6s after boot, well before `boot-hook.sh` gets a
chance to redirect it). If the robot's firmware doesn't match what this patch
was written against, `activate.sh` aborts here rather than activating with
that window silently left open.

**3. Verify.** Open `http://<robot-ip>` (or whatever the robot's IP is)
in a browser — you should see the map and controls. This is Valetudo's own
UI; the Kärcher UI is also available at `http://<robot-ip>/karcher-ui/` (see
"Two web UIs are available" below). If you don't see anything, see
Troubleshooting below.

**4. Confirm it survives a reboot.** Reboot the robot (from its own button,
or `ssh root@<robot-ip> reboot`). Wait for it to fully boot, then check
the web UI again — it should come back on its own with zero manual steps.

That's it — the robot is now provisioned and will boot into Valetudo mode
every time until you explicitly switch it back.

## Day-to-day: switching modes

Once installed, toggle between the real vendor cloud and Valetudo any time,
directly on-device:

```sh
ssh root@<robot-ip> /userdata/valetudo/karcher-cloud-switch.sh cloud     # back to the real vendor app
ssh root@<robot-ip> /userdata/valetudo/karcher-cloud-switch.sh valetudo  # back to Valetudo
```

Whichever you choose is what the robot boots into from then on — see "The
mode file" below for why that's reliable across reboots.

**Works regardless of which region the robot was paired in.** `valetudo`
mode's `/etc/hosts` redirect targets whatever `http_host`/`mqtt_host` are
*currently* in the robot's own `/userdata/config/wifi.conf` — the exact
hostnames `aiot_client` itself connects to (confirmed via disassembly of
its `loadWifiConfig()`), re-read fresh every time this runs. A robot paired
through the real app in any region ends up with real region-specific
values there; a robot provisioned through `provision-wifi.py` ends up with
whatever that script wrote. Either way, the redirect matches what's
actually on disk — this only falls back to hardcoded EU values (with a
printed warning) if `wifi.conf` is somehow missing or unreadable.

## Two web UIs are available

Once in valetudo mode the robot serves **both** UIs at the same time, and you can use
whichever you prefer:

- **Valetudo's own UI** — `http://<ROBOT_IP>/` (the default; this is what the Verify step
  above opens). Always present and untouched, so it's the fallback if anything about the
  Kärcher UI misbehaves.
- **The Kärcher UI** — `http://<ROBOT_IP>/karcher-ui/` (see below).

Neither replaces the other; they share the same backend on the robot.

## The Kärcher UI (`/karcher-ui/`)

A second web UI, built from `contrib/karcher-rcv5/webui/` and served next to Valetudo's own
at `http://<ROBOT_IP>/karcher-ui/`. It reuses Valetudo's pages and adds Kärcher-only ones. Cleaning options opens from the action
bar. The other two are in the menu:

- **Cleaning options** (action bar): the Kärcher cleaning settings.
- **Saved maps** (Menu → Saved maps): list, rename, choose, delete and create maps. Backed by
  `/api/v2/karcher/maps/`. Creating a map drives the robot around the home without cleaning and
  adds a new map. It needs the robot docked. Map names are limited to 24 characters. The current
  map can't be deleted.
- **Camera** (Menu → Robot → Camera, the Kärcher one served by this module — not Valetudo's own
  duststream page, which shares the section but needs a different capability): live video from the robot's camera, also while it cleans.
  It plays through `mpegts.js`, which is a root `devDependency` (`npm ci` installs it).

Both pages talk to Valetudo on the robot, so they need Valetudo mode. In cloud mode there is
no Valetudo on the robot to talk to.

### The camera is off by default

Turn it on under Robot Options → Quirks → Camera. Until then the stream route answers 403 and
the Camera page says so.

What happens when someone opens the page: Valetudo starts the robot's own demo encoder
(`rkmedia_vi_venc_rtsp_test -d rkispp_scale1`), reads its H.264 stream on `127.0.0.1:554`, and
repackages it as MPEG-TS for the browser. It stops the encoder about 10 seconds after the last
viewer leaves. Nothing is transcoded. A stale encoder left behind by a killed Valetudo is stopped
at the next start. Don't start `rkmedia_vi_venc_rtsp_test` by hand while using the camera page.

**Security: read this before turning it on.** While the camera runs, the demo encoder's RTSP
server on port 554 listens on every interface and has no login. Anyone on the network can watch
the stream in that time. The robot has no firewall (no netfilter in its kernel), and the demo has
no bind or password option, so Valetudo can't close this. Valetudo's own password protects only
the web UI on port 80. Turn on Valetudo's authentication, and keep the camera off when you don't
need it. A reboot always clears a stuck encoder.

Tested so far: macOS Safari. The stream is built to the constraints Safari's media pipeline
needs, which is why parameter sets and delimiters are handled the way they are in
`backend/lib/robots/karcher/camera/`. Chrome plays it too.

## HTTPS for the web UI (opt-in)

Off by default. When turned on, Valetudo serves the same UI over HTTPS on port 8443 while
the plain HTTP server on port 80 keeps running (there is no redirect — browse to the HTTPS
URL yourself). This encrypts the connection — most usefully Valetudo's basic-auth password —
but the cert is self-signed, so the browser warns once and you click through. It gives you
privacy, not a verified identity.

Turn it on in the web UI under **Robot Options → Quirks → Web UI HTTPS** (`on`/`off`). No
config editing and no restart: toggling it starts or stops the HTTPS server right away, and
the choice is remembered across reboots (stored next to the device identity in
`/userdata/valetudo/device-identity.json`). Then open `https://<ROBOT_IP>:8443/`.

It stays on port 8443 on purpose: the dummycloud binds `127.0.13.38:443`, and on Linux a
`0.0.0.0:443` web UI listener would fight it for the port.

This is a Kärcher-only quirk — it lives entirely in the vendor module and the on-robot HTTPS
server, so nothing under `frontend/` or core `backend/` changes and upstream syncs stay
clean. SSDP/UPnP and Bonjour/mDNS still advertise plain HTTP (changing those would need core
edits).

How the cert works:

- Generated on the robot the first time HTTPS is turned on (no `openssl` on the device
  needed) and saved to `/userdata/valetudo/webui.{crt,key}`. Generating the RSA-2048 key
  takes about **9 seconds** on the Cortex-A7 — it runs in the background, so the toggle
  returns immediately and HTTPS comes up a few seconds later; later starts reuse the saved
  cert instantly.
- The SANs cover `localhost`, the `.local` name and the robot's IPs at generation time. If
  DHCP later changes the robot's IP, the browser adds a name-mismatch warning on top of the
  self-signed one — you can still proceed, or delete `webui.{crt,key}` and restart to
  regenerate for the new IP. It does **not** regenerate for an IP change on its own.
- Validity is 820 days, kept under Apple's 825-day cap so macOS/iOS accept it. Valetudo
  renews it automatically at startup once it's within 30 days of expiry, and regenerates if
  the files are missing or corrupt.
- Because the cert's start date is "now minus a day", generation waits for the clock to be
  set. If the robot boots with HTTPS on before its clock syncs, the log shows
  `clock not set yet … delaying web UI HTTPS` and it retries every 30s.

**This is not a substitute for the camera's port-554 exposure** (see above) or for any other
open port — it only covers the web UI.

## Other files in this directory

- `CAPABILITY_MAP.md`: what the Kärcher app exposes and which Valetudo capabilities this
  module covers.
- `device/README.md`: the short quick-reference that `install.sh` copies onto the robot.
- `dev/run_dummycloud.js`, `dev/run_robot.js`: manual live-test runners for the dummycloud
  and the robot class, run from the repo root with `sudo` (they bind ports 443/8883). Run
  only one at a time. They are not part of install or build.

## Uninstalling

From `contrib/karcher-rcv5/`:

```sh
./uninstall.sh <robot-ip>            # switch back to stock, remove the boot hook, keep the binary/certs
./uninstall.sh <robot-ip> --purge    # same, and also delete /userdata/valetudo entirely
```

Either way, the irreplaceable backup files under `/userdata/` (see
"Irreplaceable files" below) are never touched.

## Checking the robot's state

Entirely read-only — safe to run against a robot in any state, including
one that's never been provisioned or was just reset. Prints every file/
mount/process this toolkit touches and its current state; nothing is
written, moved, or removed. Useful before a reset, after one, or any time
the robot's state is unclear. From `contrib/karcher-rcv5/`:

```sh
./diagnose.sh <robot-ip>
```

Covers: firmware version (and whether `/oem`'s overlay could be masking a
stale reading); disk space; every pushed file compared by md5 against your
**local checkout**, not the copy on-device — a stale or missing on-device
copy is itself one of the things this reports; the boot trampoline's two
copies; runtime state files, including `device-identity.json`'s actual
content, and JSON-validity of both it and `config.json`; the
irreplaceable backups compared against `device-originals-backup/`;
`karcher-cloud-switch.sh`'s and `aiot-gate.sh`'s own status reporting
(relayed from your local checkout, not the on-device copy, for the same
staleness reason); Valetudo's process state; any staged firmware upgrade
image; and the vendor's own `/userdata/debug_mode` SSH/ADB gate flag. Ends
with a count of items that need attention (the exit code reflects it too).

### If you only have the robot, not this checkout

`install.sh` also pushes `/userdata/valetudo/manage.sh` — a self-contained
on-device entry point for exactly the situation where you have SSH access
to the robot but not this repo or README. Run it with no arguments (or
`ssh root@<robot-ip> /userdata/valetudo/manage.sh`) and it prints the
current state plus what you can do next:

```sh
manage.sh                    # status + contextual menu (also: help)
manage.sh activate           # arm the overlay, patch the gate, switch to valetudo mode
manage.sh deactivate         # switch back to the real Kärcher cloud
manage.sh wifi [ssid]        # reconfigure WiFi (password always prompted) — see below
manage.sh uninstall [--purge]
```

It's a thin wrapper around `karcher-cloud-switch.sh`/`aiot-gate.sh`/
`S96valetudo` — the same calls `activate.sh`/`uninstall.sh` make from the
Mac, just run locally. The one thing it can't do that `activate.sh` can:
survive its own host rebooting mid-sequence. First-time activation needs
the `/oem` overlay armed, which needs a reboot before it can be patched —
`manage.sh activate` stages that and tells you to reboot and re-run it,
rather than rebooting the robot out from under your own SSH session
unannounced.

## Disaster recovery

Unsure what state the robot is actually in? Run `./diagnose.sh <robot-ip>`
first.

If a factory reset (or anything else) wipes `/userdata`, restore the
Mac-side backups first, then re-provision. `restore-originals.sh` pushes the three core
backups (`etc-hosts.orig`, `server.crt.orig`, `gdroot-g2.crt.orig`). It does not push
`wifi-deamon.sh.orig`. `aiot-gate.sh patch` makes a fresh one on the next `activate.sh`.
From `contrib/karcher-rcv5/`:

```sh
./restore-originals.sh <robot-ip>
./install.sh <robot-ip>
./activate.sh <robot-ip>
```

### Firmware A/B slots — what's actually recoverable

Live-verified partition table (`cat /proc/mtd`): `vnvm` (1MB), `uboot` (5MB,
**single, not A/B**), `boot_a`/`boot_b` (**10MB each**, kernel+DT), `misc` (0.5MB),
`system_a`/`system_b` (**100MB each**, rootfs), `robotconf` (20MB), `userdata`
(232MB), `reserve` (30MB). **There is no separate recovery/golden partition** —
`/oem` is just a directory inside whichever rootfs squashfs (`system_a` or
`system_b`) is currently active, not its own partition.

This is a standard Rockchip A/B layout: `/usr/bin/updateEngine` reads/writes slot
metadata in the `misc` partition (`--misc=now` reconfirms the current slot,
`--misc=other` switches to the inactive one). `boot_*` and `system_*` are two
independent A/B pairs, but they share **one** slot pointer and always switch
together — an OTA always writes both halves of the slot you're **not** currently
running, then boots it. `uboot` itself has no A/B fallback at all. The recessed
reset button's long-hold (~11s+) also calls `--misc=other` — a real slot switch,
not just a config wipe.

**What the ~100MB OTA image actually contains** (`Kaercher_RCV5_EU-I3.12.90.img`,
parsed directly): an outer RKFW header + embedded MiniLoaderAll.bin (~246KB,
maskrom-stage bootloader), then an RKAF container (magic at `0x3d9b4`) whose
4-entry manifest lists `parameter.txt`, `uboot.img`, `boot.img`, and `rootfs.img`.
The squashfs superblock for `rootfs.img` reports a filesystem size of
**89,505,904 bytes** — this one file is ~85% of the whole package; the rest is the
bootloader/kernel pieces and small headers. It's plain RKAF, readable with
`strings`/hexdump — no real encryption despite `upgrade`'s "custom container"
parsing logic, which is just this format's own hash/manifest handling.

**The catch: switching slots only surfaces whatever happens to already be in the
other slot.** There's no protected stock copy. Two (or more) ordinary OTAs can — and
on a well-used robot, will — leave both slots on the same current build, at which
point the button/switch is a no-op. Check before relying on it:

```sh
# which slot is active, and its reported version
cat /proc/cmdline | tr ' ' '\n' | grep ubi.mtd=   # e.g. ubi.mtd=6 -> system_b -> mtd6
cat /oem/sysconf/sysVersion.ini

# compare the two slots' rootfs WITHOUT booting either (read-only; mtd5=system_a here)
ubiattach /dev/ubi_ctrl -m 5 -d 5 && ubiblock --create /dev/ubi5_0
md5sum /dev/ubiblock0_0 /dev/ubiblock5_0      # ubiblock0_0 = active root
# equal md5 => both slots already the same build, switching won't recover anything
umount /tmp/sa 2>/dev/null; ubiblock --remove /dev/ubi5_0; ubidetach -m 5

# or just read the inactive slot's version directly:
mkdir -p /tmp/sa && mount -t squashfs -o ro /dev/ubiblock5_0 /tmp/sa
cat /tmp/sa/oem/sysconf/sysVersion.ini
umount /tmp/sa
```

Dump a slot without mounting it at all (strictly read-only, safe to pipe off-device):
`nanddump --omitoob -f - /dev/mtd5 | ssh <mac> 'cat > system_a.ubi'` (`mtd2`/`mtd3` for
the much smaller `boot_a`/`boot_b`, whose U-Boot FIT `/timestamp` is a quick way to
date-fingerprint a build without extracting the rootfs at all).

**If both slots already match, there's no on-device path back to an older build** —
only an off-device image (if you have one) reflashed via maskrom + `rkdeveloptool`
gets you there, and that's unexplored/untested by this project.

## Updating firmware

> **Not finished, not tested. For information only. Use at your own risk.**
> `upgrade-firmware.sh` stages an image and never flashes it. The OTA trigger described
> below is a disassembly-level lead that has never been run. Nothing in this section is
> needed to run Valetudo on a robot that already has the supported firmware (`I3.12.90`).

If `install.sh` or `upgrade-firmware.sh` report a firmware mismatch (see
"Installing on the robot" above), `upgrade-firmware.sh` downloads, verifies,
and stages the correct image on the robot — it does **not** flash it. From
`contrib/karcher-rcv5/`:

```sh
./upgrade-firmware.sh <robot-ip>
```

**What it does**: reads the robot's current `sysVersion`/`sysVersionCode`;
if it already matches this tooling's target (`I3.12.90`), warns and exits —
nothing to do. If the robot reports a *newer* build than the target, it
refuses outright: staging an older image would be a downgrade, and this
tooling hasn't been re-verified against whatever newer firmware that is.
Otherwise it checks free space on `/userdata`, downloads the official image
from Kärcher's CDN (cached at `~/Downloads/Karcher app-FW/` after the first
run, matching the convention already used for firmware research in the
sibling `karcher-rcv5-ha` repo — outside any repo, never committed), verifies
its md5, and pushes the verified copy to a neutral path on the robot
(`/userdata/valetudo-firmware-upgrade/`) — deliberately *not* the path the
vendor's own updater is suspected to watch, so staging it can never
accidentally trigger anything.

**Stale-version caveat.** Both firmware checks read `/oem/sysconf/
sysVersion.ini`. Once `activate.sh` has ever armed the `aiot-gate.sh` `/oem`
overlay on a robot, `/oem` becomes a bind-mount from a copy at
`/userdata/debug_dir/oem` — and `overlay_on()` re-arms an *existing* copy
without refreshing it. So if a firmware update happens (by any method) while
that overlay is active, the version these checks report can be a stale
snapshot, not what's really flashed. Both `install.sh` and
`upgrade-firmware.sh` warn when this is the case; when in doubt:
```sh
ssh root@<robot-ip> /userdata/valetudo/aiot-gate.sh overlay off
```
then reboot and re-check.

**Space math.** The image is ~100MB. On a 198MB `/userdata` partition, that
competes with whatever else is already there: a Valetudo install is ~32MB
(`uninstall.sh <robot-ip> --purge` reclaims it), and the `aiot-gate.sh`
overlay copy — if ever armed — is ~109MB on its own (`aiot-gate.sh overlay
off` reclaims it, but that also undoes the boot-time cloud-window patch and
the cert swap; not a casual toggle, only worth it if valetudo mode isn't
needed right now). `upgrade-firmware.sh` checks both and tells you which
would actually free enough.

**Once staged**, the script's own final output gives two options:

- **(a) Via the official app**: remove the staged file and switch the robot
  back to cloud mode (`karcher-cloud-switch.sh cloud` — the real app can't
  reach a dummycloud-redirected robot), then pair through the official
  Kärcher app, which offers a firmware update as part of that flow. This is
  the vendor's own path. This project has not tested a firmware update
  through it. Pairing itself does **not** need the app — see "Recovering
  from a WiFi/config reset" below.
- **(b) On hold, not tested** — see the next section.

### Local OTA trigger (on hold, not tested)

**Status: reverse-engineered by full disassembly, deliberately not attempted live.**
An earlier version of this section described a local *file-drop* handoff
(`/userdata/Download/update.img` + `/userdata/NewOta` + `/tmp/ota_start`),
inferred from `strings`/symbol analysis alone — that theory is **disproven**:
direct disassembly of `/oem/bin/upgrade` found zero callers of the functions
that theory depended on. The real mechanism, found by actually disassembling
`upgrade`'s control flow, is different and much better understood:

- `upgrade` binds an **unauthenticated `AF_UNIX SOCK_DGRAM` socket**
  (`chmod 0777`) at `/tmp/UDP_UPGRADE_SEND_PATH` — despite the "UDP" naming,
  it's a Unix-domain socket, not real UDP/IP.
- A two-datagram message (a 20-byte header, then a payload with a URL string,
  an MD5 field, and a destination path) sent to that socket sets the daemon's
  internal state machine into its download state.
- The download step uses `libcurl` with `CURLOPT_PROTOCOLS` set to allow
  *every* protocol, including `file://` — so a URL pointing at an
  already-downloaded local file (e.g. what `upgrade-firmware.sh` stages)
  would be fetched exactly like a real CDN download.
- After a successful download and MD5 check, the daemon decrypts a custom
  container format and calls into an **A/B partition-write path**
  (`RK_ota_start()`) that writes the new firmware live, in-process, then
  triggers an immediate reboot (`echo b > /proc/sysrq-trigger`) — there's no
  separate boot-time recovery pass; by the time it reboots, the write is
  already done.
- Confirmed on real hardware (2026-09-26, read-only): the daemon is running,
  the socket exists with exactly the predicted permissions, and its log file
  (`/userdata/log/upgrade.temp`) matches the disassembly's log strings
  exactly. It also **actively deletes** `/userdata/update.img` and
  `/tmp/update.tmp` on every startup — confirming the old file-drop theory
  wouldn't have worked even before it was disproven by disassembly.

**Why this is on hold rather than being tried**: sending this trigger for
real would be the first write path this project has attempted with no known
way back. Every other recovery lever this project relies on assumes a reset
can get the robot to a clean/known state — but five independent reset
mechanisms have now been tested (the physical button, the app's "Factory
reset," the app's "Privacy / Withdraw Consent" flow, and two others from an
earlier session) and **none of them revert firmware**, so there's currently
no confirmed way to deliberately move this robot to an older firmware
version first. Until a way to do that exists (or someone's willing to accept
the risk without it), the local trigger stays a documented, disassembly-level
lead — not something to run. If you want the full byte-level protocol
(exact struct offsets, the specific `msg_type` values tried, the log-string
cross-references), ask — it's tracked in detail outside this README.

## Recovering from a WiFi/config reset

Unsure what state the robot is actually in? Run `./diagnose.sh <robot-ip>`
first.

Three different ways to trigger a reset on this robot were all live-tested 2026-09-21
and land on the same **shallow** wipe — shallower than a full `/userdata` factory
reset:

1. The Kärcher app's "reset and remove robot" action.
2. Holding both of the robot's top physical buttons together for 5+ seconds (announces
   "network and wifi configuration mode") does **not** do the wipe described below. It's a
   different mechanism (RobotApp → `wifiManager`, not the recessed button's GPIO81 path)
   that brings up the robot's own onboarding AP and only deletes
   `/userdata/config/wifi.conf` — `wpa_supplicant.conf` (the actual saved WiFi credentials)
   and the rest of `/userdata/config` are untouched, and no reboot occurs. See
   "Configuring WiFi via the robot's own AP" below — with Valetudo installed, this is the
   preferred way to use this button.
3. The small recessed reset button under the main cover (announces "System has been
   restored").

All three clear `/userdata/config`, `/userdata/log`, and `/userdata/cfg` (WiFi
credentials included) and drop the robot back into an unpaired, no-WiFi state — but
none of them touch `/userdata/debug_mode`. Symptom: SSH stops working (no network to
reach it over), but `adb` over the internal USB OTG port still works, and root is
intact.

To get WiFi back without going through the app's SoftAP re-pairing flow:
`wpa_supplicant` is already running (`S66_wifi` starts it at boot regardless of whether
any network is configured), so reconfigure it live over its control socket. From
`contrib/karcher-rcv5/`:

```sh
./configure-wifi.sh              # prompts for SSID and password (password hidden, never
                                  # passed as an argument or left in shell history)
```

Stages the network, verifies `wpa_state=COMPLETED` (polling, not a blind sleep), and only
*then* saves it to disk — a failed attempt never overwrites the last known-good config, so
a typo'd password can't strand the robot on the next reboot. Reports the assigned IP when
done. Uses `adb`, not `ssh` — unlike every other script here, since the whole reason this
one exists is that the reset just killed network connectivity.

Also ensures `/userdata/config/wifi.conf` has the cloud-pairing fields
`uid`/`key`/`http_host`/`mqtt_host`/`mqtt_port`/`district` — filling in only
whichever are genuinely missing (safe, non-account-identifying placeholders for
`uid`/`key`, real EU hostnames for the rest — never a fake/unresolvable one,
which would permanently break `karcher-cloud-switch.sh cloud`), never touching
real values already there. Without at least `http_host`/`mqtt_host` present,
`aiot_client` has nowhere to connect to at all, so it never even attempts the
connection `karcher-cloud-switch.sh valetudo`'s redirect is meant to intercept
— Valetudo would receive zero communication from it, not just be
"unprotected." `manage.sh wifi` does the same thing on-device — the two are
meant to be fully interchangeable, neither requiring the other.

**Caveat**: a separate vendor process, `wifiManager` (started later in boot than the
`S66_wifi`/`wpa_supplicant` service above), also has code paths that rewrite this same
config file (`remove_network all`, `killall wpa_supplicant`, rebuilding it from a `_tmp`
copy) — under conditions this project hasn't fully mapped. If the connection doesn't
survive a *subsequent* reboot (e.g. the one `activate.sh`'s first run triggers), re-check
with `adb shell wpa_cli -i wlan0 status` before assuming something else is wrong.

**Connected only via `adb shell` with no laptop checkout, but Valetudo is already
installed?** `manage.sh wifi [ssid]` (see "If you only have the robot, not this
checkout" above) is the same stage/verify/save logic — including ensuring
`wifi.conf`'s cloud-pairing fields exist, see `configure-wifi.sh` above for why
that matters — run on-device, no `adb push` needed, works identically over
`adb shell` or `ssh`:

```sh
adb shell /userdata/valetudo/manage.sh wifi
```

**No root, no adb, no laptop checkout of the robot at all — just WiFi range?**
`provision-wifi.py` speaks the official Kärcher app's own SoftAP pairing protocol
directly, reverse-engineered from a real capture (see its own header comment for
the full protocol writeup). Works on a robot that's never been rooted or even
paired before — the other two options above both assume root access already
exists. From `contrib/karcher-rcv5/`:

```sh
python3 provision-wifi.py
```

Trigger the robot's onboarding hotspot with the two-top-buttons hold, join it
from your Mac's WiFi settings, then run the script. It only prompts for the
home WiFi SSID/password — the robot also requires five cloud-pairing fields
to be *present* (never validates their content, confirmed via disassembly),
but the script fills those in automatically rather than prompting, since
every extra prompt eats into the timing window below.

**Account safety**: `uid` is which Kärcher cloud *account* ends up owning the
robot — not a robot identifier — and this toolkit supports switching a robot
back to real cloud mode later (`karcher-cloud-switch.sh cloud`). Because of
that, `uid`/`key` default to freshly-generated placeholders that can never be
mistaken for a real account, never a real captured value. If you want to
preserve a specific robot's real prior account link, read its actual `uid`
from `/userdata/config/wifi.conf` over ssh *before* triggering the reset (the
reset wipes it from the robot itself), then pass it as `RCV5_UID=... python3
provision-wifi.py` (also: `RCV5_SSID`, `RCV5_PWD`, `RCV5_KEY`,
`RCV5_HTTP_HOST`, `RCV5_MQTT_HOST`, `RCV5_MQTT_PORT`, `RCV5_DISTRICT` — never
pass these as command-line args, only env vars or the interactive prompts).

**Timing matters**: the robot's pairing socket only stays open for about 7
seconds starting ~2s after the button trigger, and it's a one-shot window,
not recurring — the script walks you through this explicitly (answer every
prompt first, *then* it tells you exactly when to press the buttons,
immediately before it starts retrying the connection). Needs the
`cryptography` package (see "Prerequisites" above — same one `gen_cert.py`
needs, not a new dependency).

What it does under the hood, and how to do it by hand if you don't have either —
same `wpa_cli` sequence, run directly over `adb shell`:

```sh
adb shell
wpa_cli -i wlan0 add_network                        # returns a network id, e.g. 0
wpa_cli -i wlan0 set_network 0 ssid '"YourSSID"'     # literal quotes required
wpa_cli -i wlan0 set_network 0 psk '"YourPassword"'
wpa_cli -i wlan0 enable_network 0
wpa_cli -i wlan0 select_network 0
wpa_cli -i wlan0 save_config                         # persists to /userdata/cfg/wpa_supplicant.conf
```

`dhcpcd` (`S41dhcpcd`) already runs as a persistent daemon watching every interface, so
it picks up the new link automatically — no separate DHCP step, no reboot needed. Check
with `wpa_cli -i wlan0 status` (look for `wpa_state=COMPLETED`) and `ifconfig wlan0`.

Once SSH is back, treat it like any other `/userdata` wipe — see "Disaster recovery"
above if `/userdata/valetudo` itself also needs restoring.

**`/userdata/config/wifi.conf` is a separate problem from the WiFi network itself.**
The `wpa_cli` recipe above only restores the robot's *network* connectivity (`ssid`/
`psk`). The same reset also wipes `wifi.conf`'s cloud-pairing fields — `uid`, `key`,
`district`, `http_host`, `mqtt_host` — which `aiot_client` needs to log in at all (see
"Fields now show in Valetudo" history in this repo). **`key` and `district` are
pairing-session values the cloud reissues on every fresh pairing, not fixed per-device
secrets** — live-confirmed 2026-09-21: hand-restoring them from an old backup got the
robot fully connected (login, MQTT, map/log uploads all worked), but every remote
command silently did nothing for the rest of that session, while the physical
Start button worked normally throughout. Root cause was never fully isolated (the
robot's firmware had also reverted to an older version across the same reset, which
is at least as likely an explanation as the stale pairing fields), but a fresh pairing
immediately fixed it.

**You don't need the Kärcher app or the cloud to provision a robot.** On the supported
firmware (`I3.12.90`), the robot's own AP flow (below) or `provision-wifi.py` gets it fully
onto your WiFi, and Valetudo runs from there with no app and no cloud. Pairing fields you
restore by hand from an old backup are the less reliable route.

**If a robot recovered by hand connects and uploads fine but ignores every command
from the UI while the physical button still works, don't keep debugging Valetudo.**
Redo the WiFi setup through the robot's own AP (below) or `provision-wifi.py`. Then check
the firmware is `I3.12.90`. Then re-run `karcher-cloud-switch.sh valetudo` (it only
*reads* `wifi.conf` — to pick the right hosts to redirect, see "Day-to-day: switching
modes" above — never writes it, so the fresh pairing carries over).

This is the class of problem `install.sh`'s firmware check (see "Installing on the robot"
above) catches immediately and by name, instead of surfacing later as an unexplained
silent command failure. Re-run `install.sh` to confirm the firmware before assuming
everything else is fine.

### Configuring WiFi via the robot's own AP (preferred)

With Valetudo installed and running, the two-top-buttons combo needs none of the
`adb`/laptop-checkout workarounds above — it's a self-contained flow through Valetudo's
own UI.

Hold both top buttons for a few seconds. The robot announces "Reset the wifi connection
and enter network configuration mode" and brings up its own open WiFi access point
(no password). Join it from any phone or laptop, then browse to `http://192.168.5.1` —
Valetudo's WebUI is reachable there, including its WiFi Connectivity page, which shows
live status and lets you scan for and submit a new network's SSID/password directly —
no app, no cloud, no `adb`.

What's actually happening (`backend/lib/robots/karcher/KaercherWifiApController.js`):

- The AP is `wifiManager`'s own onboarding mechanism (`hostapd`+`dnsmasq` on `wlan0` at
  `192.168.5.1`) — Valetudo doesn't build its own AP, it detects and works with the
  robot's existing one.
- The button's only real side effect is deleting `/userdata/config/wifi.conf`
  (`wpa_supplicant.conf`, the actual saved credentials, is untouched). Valetudo shadow-copies
  `wifi.conf` continuously and restores it automatically once AP mode ends, so this doesn't
  silently break cloud-pairing the way it would without Valetudo running.
- **10-minute window**: if nothing gets configured within 10 minutes of the AP coming up,
  it automatically reverts to whatever network was active before — no manual recovery
  needed. This is a *single* window covering both connecting to the AP and submitting the
  form, not two separate allowances, so don't dawdle before joining.
- Submitting a new network writes it into `wifi.conf` and lets `wifiManager`'s own
  `StopAp()`/`wpaConnect()` do the actual switch; if it fails to connect, the same
  auto-revert logic falls back to the previous network.

This only applies while Valetudo is installed and running. Without it, the button still
works exactly as it always did — the app's own SoftAP re-pairing flow, or the `adb`/
`provision-wifi.py` workarounds elsewhere in this section.

## Troubleshooting

- **Something looks wrong and you're not sure what**: run `./diagnose.sh
  <robot-ip>` first — see "Checking the robot's state" above.
- **`install.sh` can't reach the robot**: confirm its current IP
  (`arp -a` on the Mac, or check your router) — it's DHCP-assigned and can
  change.
- **`install.sh` fails on a firmware mismatch**: this tooling only supports `I3.12.90`.
  `./upgrade-firmware.sh <robot-ip>` can stage the image, but it is unfinished and untested
  — see "Updating firmware" above. Use at your own risk.
- **Activated, but no map/controls in the web UI**: give it a few seconds —
  `activate.sh` has a built-in `sleep 2` before the switch, and the switch
  script itself waits up to 20s for `RobotApp` to respawn. If it's still
  broken after a minute, `ssh root@<ip> cat /etc/hosts` should show the
  `127.0.13.38` redirect lines; if it doesn't, the switch didn't actually
  take — re-run `./activate.sh <ip>`.
- **Reboot came back in stock mode when you expected valetudo mode**: check
  `ssh root@<ip> cat /userdata/valetudo/mode` — if it's missing or says
  `cloud`, `activate.sh` was never successfully run (or ran before this
  mode-file mechanism existed). Re-run `./activate.sh <ip>`.
- **Repeated password prompts**: see `lib.sh` — every script in this
  directory should only prompt once per run via SSH ControlMaster. If
  you're being prompted repeatedly within one script, something's killing
  the control socket (e.g. `~/.ssh/controlmasters/` not writable).

---

## Reference

### The mode file

`/userdata/valetudo/mode` holds exactly `cloud` or `valetudo` — written only
by `karcher-cloud-switch.sh`, after its own verify steps already passed.
Absent, empty, or anything other than the literal string `valetudo` is
treated as `cloud` (safe default: a never-activated or corrupted-state robot
always boots stock). `boot-hook.sh` reads it on every boot to decide whether
to reapply the redirect; `karcher-cloud-switch.sh` itself never reads it back.

This is what makes the setup genuinely **switchable**: manually running
`karcher-cloud-switch.sh cloud` on-device and rebooting keeps the robot
stock on the next boot too, instead of silently reverting to valetudo mode.

### Why the boot hook is two files

`/etc/init.d` is read-only squashfs on this device — genuinely unmodifiable.
The only usable hook is `/etc/init.d/S99_auto_reboot` (a Rockchip QA/
power-loss-test script), which **sources** (not executes) a file from
`/userdata/cfg/rockchip_test/auto_reboot.sh` at the end of every boot,
passing it a QA reboot counter as `$1`.

Because it's sourced into `S99_auto_reboot`'s own shell, that file must never
`set -e`, `exit`, or reference `$1`/`$@`. So it stays a permanently inert
one-liner (`auto_reboot.sh`) that just execs `boot-hook.sh` as a real
subprocess — all actual logic (mode check, starting Valetudo, reapplying the
switch) lives in `boot-hook.sh`, which is free to use normal shell
semantics. **Do not merge these back into one file** — that reintroduces a
real bug class (a stray `exit` or `set -e` taking down the vendor's own boot
script).

### Known limitations (not fixed by this tooling)

- **Dormant clobber-guard in `S99_auto_reboot`.** If a future vendor OTA
  ever ships `/oem/rockchip_test/auto_reboot.sh`, that vendor script's own
  guard would start overwriting our `auto_reboot.sh` on every boot. No
  runtime self-check is built for this — moot as long as no vendor OTA is
  ever applied to a rooted unit.
- **The hosts-file block can't stop everything. Block WAN on the router.**
  `RobotApp` and `log-server` have their own cloud contact, separate from
  `aiot_client` (which the boot-time `aiot-gate.sh` gate holds back). In
  valetudo mode `karcher-cloud-switch.sh` points these hosts at loopback
  (`BLOCK_HOSTS`):
  - `das.3irobotics.net`, `log.3irobotics.net` and `ota.3irobotics.net`. Note
    **`3irobotiCs`**, a different domain from the `3irobotiX` one the main
    redirect targets.
  - `ota.3irobotix.net` and the firmware CDNs.
  - `aiot-devlog-prod.oss-cn-shenzhen.aliyuncs.com`. This one was missing
    until 2026-10-03, and a live check that day caught `log-server` uploading to
    it in valetudo mode: 110 uploads, about 24 MB in 20 hours. The uploads
    included device logs, the cloud bridge's logs, AI-server logs, raw SLAM map
    data (`relo_globalSlam.rawlog`) and map scheme files. `log-server` signs
    these uploads with an Alibaba key built into the binary, so it needs no
    vendor cloud at all.

  Two gaps remain:
  - The list was built by grepping the binaries' strings, so a host that wasn't
    enumerated would slip through.
  - The binaries hardcode IP addresses that bypass DNS entirely: `aiot_client`
    (`203.107.1.x`, `8.219.58.10`, `8.219.89.41`), `log-server`
    (`120.78.95.51`) and the shipped-but-unlaunched `rtty` remote shell
    (`39.108.250.100`).

  The kernel has no netfilter, so the only full fix is on the network. Give the
  robot LAN-only access on your router. First set Valetudo's NTP server to a LAN
  NTP server's IP address, so `aiot_client`'s own time check still passes (see
  above).

- **The camera's RTSP port is open to the network while it runs.** See "The Kärcher UI" above.
  The demo encoder binds port 554 on all interfaces with no authentication, and the robot's
  kernel has no netfilter to block it. Opt-in plus a short run time are the only mitigations
  so far. A loopback-only bind (a small `LD_PRELOAD` shim) is the intended fix and isn't built.

### Irreplaceable files

`/userdata/{etc-hosts,server.crt,gdroot-g2.crt}.orig` on-device, mirrored to
`device-originals-backup/` on the Mac, are the only record of this
robot's pre-Valetudo state. `install.sh` also mirrors `wifi-deamon.sh.orig` (the backup
from `aiot-gate.sh patch`) there. `restore-originals.sh` restores only the first three. `/userdata` is wiped by a factory reset, so the
Mac-side copy is the only thing that makes `restore-originals.sh` possible
after one. No script here — including `uninstall.sh --purge` — ever deletes
either copy.
