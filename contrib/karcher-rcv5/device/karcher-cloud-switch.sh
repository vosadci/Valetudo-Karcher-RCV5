#!/bin/sh
# karcher-cloud-switch.sh — toggle the RCV5 between its real 3irobotix cloud and a
# local Valetudo dummycloud. Deploy to /userdata/valetudo/karcher-cloud-switch.sh
# (deliberately not under /userdata/config/, which a WiFi-reset button press wipes).
#
# The three *.orig backups this script creates (HOSTS_BACKUP/CERT_BACKUP/GDROOT_BACKUP)
# are the ONLY record of the device's original, pre-Valetudo state. They must also be
# copied off-device somewhere durable — /userdata is wiped by a factory reset
# (/oem/bin/upgrade's wipe_userdata(), see project_rcv5_factory_reset_partitions
# memory), which would make reverting to stock impossible if these were the only copy.
#
# STATUS: the cert-swap half (server.crt) is the mechanism a prior session proved live
# end-to-end (fake HTTP login + fake MQTT broker, zero real-cloud contact). The
# /etc/hosts bind-mount redirect (HOST_A/HOST_B) is LIVE-CONFIRMED (2026-09-18), reasoned out
# from static analysis of the extracted I3.12.90 rootfs (nsswitch.conf: "hosts: files dns" —
# /etc/hosts is consulted before DNS; busybox.config has no CONFIG_IPTABLES and no separate
# iptables binary exists, so there is no DNAT capability; CONFIG_FEATURE_MOUNT_FLAGS=y confirms
# busybox mount supports "-o bind"), then verified against the real device.
# An earlier draft of this script used `route add -host`, which is wrong: the kernel
# routing table has no bearing on hostname resolution — that happens in userspace via
# /etc/hosts, which lives on the read-only squashfs root and can't be edited directly,
# hence the bind-mount.
#
# The gdroot-g2.crt half (RobotApp's own, separately-linked curl/OpenSSL CA trust
# bundle — a real 128-cert standard bundle despite the "gdroot" name) was added after
# live testing found map uploads silently fail without it: RobotApp performs the real
# S3 PUT itself (not aiot_client), using its own curl instance, which validates against
# this file independently of the server.crt swap above. Confirmed live 2026-09-18 (see
# project_rcv5_valetudo_step7_live_confirmed memory).
#
# In valetudo mode, /etc/hosts also blackholes (to 127.0.0.1) several other real,
# live-resolving 3irobotix/3irobotics hosts the robot itself talks to OUTSIDE the
# aiot_client bridge (RobotApp's own direct OTA/log channels — see BLOCK_HOSTS below)
# — added 2026-09-26 after confirming they're not covered by the HOST_A/HOST_B pair.
# LIVE-CONFIRMED same day: /etc/hosts on the real device came back with exactly the
# expected 8 lines (2 dummycloud + 6 blackholed), verify_hosts/verify_processes_restarted
# passed. Confirms the redirect is in place, not (yet, via packet capture) that any of
# the six were actually about to be dialed.
#
# Every step here is reversible: `cloud` mode restores the original hosts file, cert,
# and CA bundle, and the undo for `valetudo` mode is simply running `cloud` again.

set -eu

HOSTS_BACKUP="/userdata/etc-hosts.orig"
# tmpfs, not /userdata: rebuilt on every switch and only ever used as the
# bind-mount source, so keeping it on flash just costs a write per boot.
HOSTS_VALETUDO="/tmp/etc-hosts.valetudo"
GDROOT_VALETUDO="/tmp/gdroot-g2.crt.valetudo"
CERT_BACKUP="/userdata/server.crt.orig"
CERT_TARGET_OEM="/oem/sysconf/server.crt"
CERT_TARGET_USERDATA="/userdata/config/server.crt"
CERT_VALETUDO="/userdata/valetudo/server_v1.crt"
GDROOT_BACKUP="/userdata/gdroot-g2.crt.orig"
GDROOT_TARGET="/oem/sysconf/gdroot-g2.crt"
# Read only by boot-hook.sh on the next boot — this script never reads it back
# for its own logic, it's still driven purely by the CLI arg below.
MODE_FILE="/userdata/valetudo/mode"

HOST_A_FALLBACK="eu-cdndevaiot.3irobotix.net"
HOST_B_FALLBACK="eu-gamqttaiot.3irobotix.net"
VALETUDO_IP="127.0.13.38"
WIFI_CONF="/userdata/config/wifi.conf"

# Hosts the robot itself talks to OUTSIDE the aiot_client bridge that HOST_A/HOST_B
# above cover -- confirmed by grepping every oem/bin binary's strings plus
# oem/sysconf/sysConfig.ini on the extracted I3.12.90 rootfs, and cross-checked
# against karcher-rcv5-ha's doc/INVESTIGATION.md network table (2026-09-26):
#   - ota.3irobotix.net       -- sysConfig.ini server_cmd_address/server_map_address/
#                                 server_ota_address (ports 4010/4030/8001/2300); RobotApp's
#                                 own CTcpClient, separate from the MQTT bridge. INVESTIGATION.md
#                                 documents its check endpoint as hit "on every cloud connection".
#   - eu-cdnallaiot.3irobotix.net -- documented production firmware CDN (INVESTIGATION.md).
#   - eu-cdnupdatepkgaiot.3irobotix.net -- the real firmware CDN this repo's own
#                                 upgrade-firmware.sh downloads from (lib.sh FIRMWARE_URL). Not
#                                 found hardcoded on-device, so nothing currently feeds the robot
#                                 this URL on its own -- blocked anyway, defense-in-depth.
#   - log.3irobotics.net      -- sysConfig.ini server_log_address (port 21).
#   - das.3irobotics.net      -- RobotApp/log-server string-table default, clustered with
#                                 generic SDK boilerplate; not confirmed as actually dialed, but
#                                 a real, live-resolving host, so blocked rather than assumed dead.
#   - test-devlog.3irobotix.net -- log-server's own devlog target string.
# All confirmed as real, currently-resolving hostnames (not dead/unregistered domains) via `dig`.
# Redirected to loopback, not VALETUDO_IP: nothing needs to answer for these, unlike
# HOST_A/HOST_B which the dummycloud actively serves -- a refused/timed-out connection here IS
# the desired outcome. Applied unconditionally in valetudo mode; mode_cloud's revert-from-backup
# already removes these along with the HOST_A/HOST_B pair, since HOSTS_BACKUP never contained them.
BLOCK_HOSTS="ota.3irobotix.net eu-cdnallaiot.3irobotix.net eu-cdnupdatepkgaiot.3irobotix.net log.3irobotics.net das.3irobotics.net test-devlog.3irobotix.net"
BLOCK_IP="127.0.0.1"

# HOST_A/HOST_B are read live from the robot's own wifi.conf rather than
# hardcoded, because that's what they actually are: aiot_client's own
# loadWifiConfig() re-reads http_host/mqtt_host from this exact file on
# every startup and connects to whatever's there (confirmed via
# disassembly of aiot_client.bin) -- these two constants used to just be
# the EU values copied from one real robot's wifi.conf, which only ever
# worked for a robot whose wifi.conf happened to also say EU. Redirecting
# whatever's actually in wifi.conf instead works for any region a robot
# was paired in, with no per-region guessing, and also covers a robot
# provisioned by provision-wifi.py with placeholder cloud fields (it just
# redirects those placeholders instead). Fallback to the EU values only if
# wifi.conf is missing/unreadable -- shouldn't normally happen, since this
# script already needs a working ssh connection, which itself needs the
# robot to already be on WiFi.
wifi_conf_host() {
    if [ -r "$WIFI_CONF" ]; then
        sed -n "s/^$1=//p" "$WIFI_CONF" | head -1
    fi
}

resolve_hosts() {
    HOST_A="$(wifi_conf_host http_host || true)"
    HOST_B="$(wifi_conf_host mqtt_host || true)"
    if [ -z "$HOST_A" ]; then
        HOST_A="$HOST_A_FALLBACK"
        echo "WARNING: could not read http_host from $WIFI_CONF -- using EU fallback ($HOST_A)" >&2
    fi
    if [ -z "$HOST_B" ]; then
        HOST_B="$HOST_B_FALLBACK"
        echo "WARNING: could not read mqtt_host from $WIFI_CONF -- using EU fallback ($HOST_B)" >&2
    fi
}

restart_aiot_client() {
    # Opens aiot-gate.sh's boot gate before the kill, so wifi-deamon.sh is free to
    # relaunch immediately. Reached only after the hosts/cert changes above are
    # applied AND cmp-verified, which is exactly the point the gate waits for. A
    # plain touch on an unpatched robot, so this is safe either way, and both modes
    # want aiot_client running.
    touch /tmp/valetudo_cloud_ready 2>/dev/null || true
    killall aiot_client.bin 2>/dev/null || true
    # wifi-deamon.sh's existing supervisor relaunches it; no separate start needed.
}

restart_robotapp_stack() {
    # RobotApp needs to reload gdroot-g2.crt to pick up the CA bundle change, but
    # `killall RobotApp` alone does NOT trigger a respawn (confirmed live this
    # session) despite Monitor supposedly supervising it. `killall Monitor` does:
    # it triggers Monitor-deamon.sh's own designed self-heal path, which kills the
    # whole app stack (AuxCtrl/everest-server/RobotApp/log-server/Tesla) and
    # restarts Monitor, which relaunches everything.
    killall Monitor 2>/dev/null || true
}

# Waits (polling, not a blind sleep) for a process to reappear after a restart.
# Uses `pidof` rather than parsing `ps` output, since this session already hit
# one `ps`-related false negative ("ps was not showing all processes") while
# debugging live — not yet confirmed whether `pidof` itself is present/reliable
# on this device's busybox build, so treat this as part of what the pending
# on-device smoke test needs to confirm.
wait_for_process() {
    name="$1"
    timeout="${2:-10}"
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        if pidof "$name" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

# --- Verification: confirm each change actually took effect, not just that the
# commands that should produce it exited 0. Added after this session's own
# experience with silent failures (killall RobotApp looking fine but not
# respawning; cdnDomain/id fields being silently wrong) made "the command ran"
# an unreliable signal on this device.

verify_hosts() {
    # expected="$1": the source hosts file that should now be bind-mounted live.
    # Content comparison only — no `mountpoint -q` precheck. Confirmed live
    # 2026-09-18 that `mountpoint` gives false negatives for FILE bind mounts on
    # this device (matching its documented directory-only reliability), even
    # though the bind mount itself was genuinely active (verified independently
    # via matching inode numbers between /etc/hosts and its bind-mount source).
    if ! cmp -s "$1" /etc/hosts; then
        echo "VERIFY FAILED: /etc/hosts content does not match $1" >&2
        exit 1
    fi
}

verify_cert() {
    # expected="$1": the source cert file both targets should now match exactly.
    if ! cmp -s "$1" "$CERT_TARGET_OEM"; then
        echo "VERIFY FAILED: $CERT_TARGET_OEM does not match $1" >&2
        exit 1
    fi
    if ! cmp -s "$1" "$CERT_TARGET_USERDATA"; then
        echo "VERIFY FAILED: $CERT_TARGET_USERDATA does not match $1" >&2
        exit 1
    fi
}

verify_gdroot_valetudo() {
    if ! cat "$GDROOT_BACKUP" "$CERT_VALETUDO" | cmp -s - "$GDROOT_TARGET"; then
        echo "VERIFY FAILED: $GDROOT_TARGET is not (gdroot backup + dev cert)" >&2
        exit 1
    fi
}

verify_gdroot_cloud() {
    if ! cmp -s "$GDROOT_BACKUP" "$GDROOT_TARGET"; then
        echo "VERIFY FAILED: $GDROOT_TARGET does not match $GDROOT_BACKUP" >&2
        exit 1
    fi
}

verify_processes_restarted() {
    if ! wait_for_process aiot_client.bin 10; then
        echo "VERIFY FAILED: aiot_client.bin did not respawn within 10s" >&2
        exit 1
    fi
    if ! wait_for_process RobotApp 20; then
        echo "VERIFY FAILED: RobotApp did not respawn within 20s of killall Monitor" >&2
        exit 1
    fi
}

switch_hosts() {
    # Idempotent: unconditionally strip every existing bind-mount layer before
    # adding the new one, rather than gating on `mountpoint -q` first. Found
    # live 2026-09-18: `mountpoint` is documented to be unreliable for FILE
    # bind mounts (its device/inode heuristic is built for directories), so the
    # old `if mountpoint -q ...; then umount; fi` guard was silently never
    # firing — confirmed live by 3 stacked bind-mount layers for /etc/hosts in
    # /proc/mounts, one per script run, never unmounted. Looping `umount` until
    # it fails is safe: once every bind layer we added is gone, the next
    # attempt hits plain /etc/hosts (part of the already-mounted rootfs, not
    # its own mountpoint) and fails harmlessly, ending the loop.
    while umount /etc/hosts 2>/dev/null; do
        :
    done
    mount -o bind "$1" /etc/hosts
}

# Fails fast, before either mode_* function touches anything, so a switch that
# can't complete leaves the robot exactly as it was rather than half-applied.
# Found live 2026-09-19: switch_hosts() runs before the cert cp steps below, and
# has no dependency on /oem itself — so without this check, a boot where /oem
# isn't writable (e.g. a factory reset cleared the aiot-gate.sh overlay's
# /userdata/sys_debug_mode flag) would redirect /etc/hosts successfully, then
# fail the cert cp with set -eu, leaving hosts pointed at the dummycloud with
# stock certs still in place — neither real cloud nor working Valetudo works.
oem_writable() {
    probe="/oem/sysconf/.valetudo-rwtest.$$"
    if touch "$probe" 2>/dev/null; then
        rm -f "$probe"
        return 0
    fi
    return 1
}

require_oem_writable() {
    if oem_writable; then
        return 0
    fi
    echo "ERROR: /oem is not writable — refusing to switch (nothing has been changed)." >&2
    echo "This usually means the aiot-gate.sh overlay isn't armed, e.g. after a factory" >&2
    echo "reset cleared /userdata/sys_debug_mode. Fix with: aiot-gate.sh overlay on," >&2
    echo "then reboot, then retry this switch." >&2
    exit 1
}

# /oem and /userdata are both non-replaceable flash, and boot-hook.sh re-runs
# the valetudo switch on every boot with identical content.
copy_if_changed() {  # $1=src $2=dst
    cmp -s "$1" "$2" || cp "$1" "$2"
}

ensure_backups() {
    if [ ! -f "$HOSTS_BACKUP" ]; then
        cp /etc/hosts "$HOSTS_BACKUP"
    fi
    if [ ! -f "$CERT_BACKUP" ]; then
        cp "$CERT_TARGET_OEM" "$CERT_BACKUP"
    fi
    if [ ! -f "$GDROOT_BACKUP" ]; then
        cp "$GDROOT_TARGET" "$GDROOT_BACKUP"
    fi
}

# Caches the just-verified mode so boot-hook.sh knows what to do on the next
# boot, without ever forcing a fixed mode itself (that was the bug in the
# original ad-hoc boot hook: it always re-applied valetudo mode regardless of
# what was last chosen at runtime). Never fails the calling mode_* function —
# the switch itself already happened and was verified; losing the cached
# record of that is a warning, not a failure.
persist_mode() {
    [ "$(cat "$MODE_FILE" 2>/dev/null)" = "$1" ] && return 0
    mkdir -p "$(dirname "$MODE_FILE")" 2>/dev/null || true
    printf '%s' "$1" > "$MODE_FILE.tmp" && mv "$MODE_FILE.tmp" "$MODE_FILE" \
        || echo "WARNING: switch succeeded but mode was NOT persisted to $MODE_FILE — next boot will use the previous mode" >&2
}

mode_backup() {
    ensure_backups
    echo "backups ensured under /userdata (etc-hosts.orig, server.crt.orig, gdroot-g2.crt.orig)"
}

mode_cloud() {
    if [ ! -f "$HOSTS_BACKUP" ] || [ ! -f "$CERT_BACKUP" ] || [ ! -f "$GDROOT_BACKUP" ]; then
        echo "no backup found under /userdata — nothing to restore, already stock?" >&2
        exit 1
    fi

    switch_hosts "$HOSTS_BACKUP"

    if oem_writable; then
        copy_if_changed "$CERT_BACKUP" "$CERT_TARGET_OEM"
        copy_if_changed "$GDROOT_BACKUP" "$GDROOT_TARGET"
    elif ! cmp -s "$CERT_BACKUP" "$CERT_TARGET_OEM" || ! cmp -s "$GDROOT_BACKUP" "$GDROOT_TARGET"; then
        # /oem has no third state (see aiot-gate.sh): read-only means it's
        # already the pristine stock partition. If it doesn't already match
        # the backup, something is genuinely wrong and unfixable without the
        # overlay - fail loud rather than silently leaving mismatched certs.
        echo "ERROR: /oem is read-only and its content does not match the backup — cannot restore." >&2
        echo "Fix with: aiot-gate.sh overlay on, then reboot, then retry this switch." >&2
        exit 1
    else
        echo "/oem is already read-only and matches the backup — nothing to write there."
    fi

    copy_if_changed "$CERT_BACKUP" "$CERT_TARGET_USERDATA"

    verify_hosts "$HOSTS_BACKUP"
    verify_cert "$CERT_BACKUP"
    verify_gdroot_cloud

    restart_aiot_client
    restart_robotapp_stack
    verify_processes_restarted

    echo "switched to: real 3irobotix cloud (verified)"
    persist_mode "cloud"
}

mode_valetudo() {
    require_oem_writable
    ensure_backups
    resolve_hosts

    # Rebuilt fresh from the backup every time, never cached -- a robot
    # whose WiFi gets reset and reprovisioned with different http_host/
    # mqtt_host (different region, or a fresh placeholder pair from
    # provision-wifi.py) must not keep redirecting a stale hostname pair
    # left over from an earlier run.
    cp "$HOSTS_BACKUP" "$HOSTS_VALETUDO"
    printf '%s\t%s\n%s\t%s\n' "$VALETUDO_IP" "$HOST_A" "$VALETUDO_IP" "$HOST_B" >> "$HOSTS_VALETUDO"
    for h in $BLOCK_HOSTS; do
        printf '%s\t%s\n' "$BLOCK_IP" "$h" >> "$HOSTS_VALETUDO"
    done

    switch_hosts "$HOSTS_VALETUDO"
    copy_if_changed "$CERT_VALETUDO" "$CERT_TARGET_OEM"
    copy_if_changed "$CERT_VALETUDO" "$CERT_TARGET_USERDATA"
    # Rebuilt from the untouched backup + dev cert every time, rather than
    # appended incrementally, so repeated toggling never accumulates duplicate
    # entries in the CA bundle.
    cat "$GDROOT_BACKUP" "$CERT_VALETUDO" > "$GDROOT_VALETUDO"
    copy_if_changed "$GDROOT_VALETUDO" "$GDROOT_TARGET"

    verify_hosts "$HOSTS_VALETUDO"
    verify_cert "$CERT_VALETUDO"
    verify_gdroot_valetudo

    restart_aiot_client
    restart_robotapp_stack
    verify_processes_restarted

    echo "switched to: local Valetudo dummycloud ($VALETUDO_IP, verified), $(echo "$BLOCK_HOSTS" | wc -w) other cloud host(s) blackholed — undo with: $0 cloud"
    persist_mode "valetudo"
}

# --- Read-only status reporting (mirrors aiot-gate.sh's mode_status in
# style). Never writes anything — not even oem_writable()'s throwaway probe
# file, so this uses mountpoint -q instead. /oem has no third state (see
# the comment in mode_cloud() above): it's either the stock read-only
# rootfs or the aiot-gate.sh overlay bind-mount, so mountpoint alone is
# sufficient here, and it's a directory bind mount — the kind switch_hosts()
# already documents mountpoint as reliable for (only *file* bind mounts
# like /etc/hosts are the unreliable case).

cmp_file() {  # $1=target $2=source -> same|differs|target-absent|source-absent
    [ -f "$1" ] || { echo "target-absent"; return; }
    [ -f "$2" ] || { echo "source-absent"; return; }
    if cmp -s "$1" "$2"; then echo same; else echo differs; fi
}

backup_sanity() {  # $1=path $2=kind(hosts|cert) -> present/absent + a basic well-formedness check.
    # ensure_backups() only ever checks [ -f ... ] before deciding NOT to
    # recreate a backup — it never re-verifies an EXISTING one, so a
    # truncated/corrupted-but-present file would silently look fine there
    # forever. This doesn't fix that (recreating one automatically here
    # would risk backing up already-redirected state instead of genuine
    # stock content — see ensure_backups()'s own comment), just reports it.
    [ -f "$1" ] || { echo "absent"; return; }
    [ -s "$1" ] || { echo "present but EMPTY (0 bytes)"; return; }
    if [ "$2" = cert ]; then
        if grep -q -F -e "BEGIN CERTIFICATE" "$1" 2>/dev/null; then
            echo "present, looks like a valid cert"
        else
            echo "present but does NOT look like a valid cert (no BEGIN CERTIFICATE marker)"
        fi
    else
        echo "present, non-empty"
    fi
}

which_source() {  # $1=target, then "label path" pairs -> first matching label, else (absent)/unknown
    target="$1"
    shift
    [ -f "$target" ] || { echo "(absent)"; return; }
    while [ $# -ge 2 ]; do
        label="$1"
        path="$2"
        shift 2
        if [ -f "$path" ] && cmp -s "$target" "$path"; then
            echo "$label"
            return
        fi
    done
    echo "unknown (matches neither known source)"
}

mode_status() {
    echo "mode file                 : $(cat "$MODE_FILE" 2>/dev/null || echo '(absent -> cloud)')"
    echo "backup: $HOSTS_BACKUP  : $(backup_sanity "$HOSTS_BACKUP" hosts)"
    echo "backup: $CERT_BACKUP   : $(backup_sanity "$CERT_BACKUP" cert)"
    echo "backup: $GDROOT_BACKUP : $(backup_sanity "$GDROOT_BACKUP" cert)"

    echo "/etc/hosts source         : $(which_source /etc/hosts stock "$HOSTS_BACKUP" valetudo "$HOSTS_VALETUDO")"
    # switch_hosts()'s own comment documents mountpoint giving false
    # negatives for this FILE bind mount, and three stacked layers going
    # undetected live once — count them directly instead of trusting it.
    # `|| true` (not `|| echo 0`): grep -c already prints "0" itself on a
    # zero-match search of an existing file, but also exits 1 for that —
    # `|| echo 0` used to add a SECOND "0" line on top of grep's own,
    # under set -e's command-substitution rules. `|| true` neutralizes the
    # exit code without adding output; ${hosts_layers:-0} covers the
    # genuinely-file-absent case (grep prints nothing then).
    hosts_layers=$(grep -c ' /etc/hosts ' /proc/mounts 2>/dev/null || true)
    hosts_layers="${hosts_layers:-0}"
    extra=""
    if [ "$hosts_layers" -gt 1 ] 2>/dev/null; then
        extra=" (STACKED - see switch_hosts() comment)"
    fi
    echo "/etc/hosts bind layers    : ${hosts_layers}${extra}"

    echo "$CERT_TARGET_OEM      : $(which_source "$CERT_TARGET_OEM" stock "$CERT_BACKUP" valetudo "$CERT_VALETUDO")"
    echo "$CERT_TARGET_USERDATA : $(which_source "$CERT_TARGET_USERDATA" stock "$CERT_BACKUP" valetudo "$CERT_VALETUDO")"
    echo "  oem/userdata agree      : $(cmp_file "$CERT_TARGET_OEM" "$CERT_TARGET_USERDATA")"

    if [ ! -f "$GDROOT_TARGET" ]; then
        gdroot_state="(absent)"
    elif [ -f "$GDROOT_BACKUP" ] && cmp -s "$GDROOT_BACKUP" "$GDROOT_TARGET"; then
        gdroot_state="stock"
    elif [ -f "$GDROOT_BACKUP" ] && [ -f "$CERT_VALETUDO" ] && cat "$GDROOT_BACKUP" "$CERT_VALETUDO" 2>/dev/null | cmp -s - "$GDROOT_TARGET"; then
        gdroot_state="stock+valetudo-dev-cert"
    else
        gdroot_state="unknown (matches neither known composition)"
    fi
    echo "gdroot bundle             : $gdroot_state"

    echo "/oem source               : $(mountpoint -q /oem 2>/dev/null && echo 'overlay (writable)' || echo 'stock rootfs (read-only)')"
}

case "${1:-}" in
    cloud) mode_cloud ;;
    valetudo) mode_valetudo ;;
    backup) mode_backup ;;
    status) mode_status ;;
    *)
        echo "usage: $0 {cloud|valetudo|backup|status}" >&2
        exit 1
        ;;
esac
