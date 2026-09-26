#!/bin/bash
#
# Shared by install.sh/activate.sh/uninstall.sh/restore-originals.sh/
# upgrade-firmware.sh/diagnose.sh. Source with `. "$SCRIPT_DIR/lib.sh"` and
# pass "${SSH_OPTS[@]}" to every ssh/scp call.
#
# The robot's /root is read-only squashfs (same constraint as /etc/init.d),
# so real key-based auth can't be set up there — every connection needs the
# root password. ControlMaster multiplexing means that only has to happen
# ONCE per script run (the first ssh/scp call opens a persistent connection),
# not once per call — install.sh alone makes about ten of them.
#

CONTROL_DIR="$HOME/.ssh/controlmasters"
mkdir -p "$CONTROL_DIR"
chmod 700 "$CONTROL_DIR"

SSH_OPTS=(-o "ControlMaster=auto" -o "ControlPersist=10m" -o "ControlPath=$CONTROL_DIR/%r@%h:%p" -o "ServerAliveInterval=5" -o "ServerAliveCountMax=3")

# Bold/colored output for the lines that matter most — final results, next
# steps, errors — so they stand out against scp/ssh's own noisy progress
# output instead of scrolling past unnoticed. Falls back to plain text when
# stdout isn't a terminal (e.g. piped to a log file).
if [ -t 1 ]; then
    BOLD=$'\033[1m'
    GREEN=$'\033[1;32m'
    # Yellow (1;33) used to sit here — too close to GREEN to tell apart at a
    # glance in some terminal color schemes, which made ISSUE lines in
    # diagnose.sh read as success. Magenta is unambiguous against both green
    # and red.
    MAGENTA=$'\033[1;35m'
    RED=$'\033[1;31m'
    RESET=$'\033[0m'
else
    BOLD=''
    GREEN=''
    MAGENTA=''
    RED=''
    RESET=''
fi

# ok: "it worked" / "here's what to do next".
ok() {
    printf '%s%s%s\n' "$BOLD$GREEN" "$*" "$RESET"
}

# warn: non-fatal but worth noticing.
warn() {
    printf '%s%s%s\n' "$BOLD$MAGENTA" "$*" "$RESET" >&2
}

# err: fatal — pairs with `exit 1` at the call site, doesn't exit itself.
err() {
    printf '%s%s%s\n' "$BOLD$RED" "$*" "$RESET" >&2
}

# Ctrl-C during a password prompt, a polling loop, or a long scp/curl
# transfer used to just print bash's own bare "Killed by signal 2" (or
# nothing at all). This makes the stop explicit instead. Whatever EXIT trap
# the calling script already set (staged-network cleanup, temp-file removal,
# etc.) still runs right after — `exit` always triggers it, this doesn't
# replace it, INT and EXIT are independent traps.
on_sigint() {
    warn ""
    warn "Interrupted (Ctrl-C) -- stopping."
    exit 130
}
trap on_sigint INT

# Firmware this tooling (aiot-gate.sh's wifi-deamon.sh patch above all) is
# anchored to. install.sh refuses to proceed without it; upgrade-firmware.sh
# stages an image to get a robot onto it. Bump together if this tooling is
# ever re-verified against a newer build.
EXPECTED_FIRMWARE="I3.12.90"
EXPECTED_FIRMWARE_CODE=90   # sysVersionCode=, numeric — lets a downgrade be
                            # told apart from a plain mismatch.

# Official Kärcher OTA image for $EXPECTED_FIRMWARE. URL/md5/size confirmed
# live 2026-08-04 (plain HTTPS, no auth) via this model's tryUpgrade REST
# response. Hardcoded rather than queried live: discovering it normally
# needs an authenticated Kärcher cloud session (the sibling karcher-rcv5-ha
# repo's Python adapter), too heavy to shell out to from here. If curl
# starts 404ing, the vendor likely rotated this URL (it's date-stamped) —
# re-discover it via that adapter, don't guess a new one.
FIRMWARE_URL="https://eu-cdnupdatepkgaiot.3irobotix.net/prod/app-product/0/2025-10-10/Kaercher_RCV5_EU-rv1126-linux-ota-release-I3.12.90-20250709_110641_1757150218900704_1760088385006894.img"
FIRMWARE_MD5="e423237df246b08561956afbdbbc903e"
FIRMWARE_SIZE_BYTES=104808920

# remote_firmware_version/_code REMOTE — read sysVersion/sysVersionCode from
# /oem/sysconf/sysVersion.ini. Empty on unreachable/missing/malformed.
remote_firmware_version() {
    ssh "${SSH_OPTS[@]}" "$1" "sed -n 's/^sysVersion=//p' /oem/sysconf/sysVersion.ini 2>/dev/null" || true
}
remote_firmware_code() {
    ssh "${SSH_OPTS[@]}" "$1" "sed -n 's/^sysVersionCode=//p' /oem/sysconf/sysVersion.ini 2>/dev/null" || true
}

# remote_oem_overlay_active REMOTE — true if /oem is currently the
# aiot-gate.sh overlay bind-mount rather than the real squashfs. A version
# read while this is true can be a stale snapshot, not live firmware — see
# overlay_on()'s "re-arms an existing copy without refreshing it" behavior.
remote_oem_overlay_active() {
    ssh "${SSH_OPTS[@]}" "$1" "mountpoint -q /oem"
}

# On-device paths shared by install.sh/upgrade-firmware.sh/diagnose.sh.
REMOTE_DIR="/userdata/valetudo"
REMOTE_TRAMPOLINE_DIR="/userdata/cfg/rockchip_test"
REMOTE_TRAMPOLINE="$REMOTE_TRAMPOLINE_DIR/auto_reboot.sh"
REMOTE_STAGE_DIR="/userdata/valetudo-firmware-upgrade"

# Portable: stock macOS has no md5sum, Linux/robot busybox has no `md5 -q`.
# Empty string (not an error) if $1 doesn't exist — callers compare against
# an empty local_sum to mean "nothing to compare against" rather than
# crashing under set -e (a real bug once: server_v1.crt/server.key are
# gitignored, so they're genuinely absent on any fresh clone before
# gen_cert.py has run).
local_md5() {
    [ -f "$1" ] || { echo ""; return; }
    if command -v md5sum >/dev/null 2>&1; then
        md5sum "$1" | awk '{print $1}'
    else
        md5 -q "$1"
    fi
}

# Every file install.sh pushes to $REMOTE_DIR, and how: "exec" gets
# chmod +x, "data" doesn't. One indexed array, not two parallel arrays or
# an associative array (stock macOS ships bash 3.2 — no declare -A), so
# install.sh's push loop and diagnose.sh's inventory both walk the same
# list. Add a file here once and both pick it up. The item is the path
# relative to $SCRIPT_DIR (device/ for the four scripts that run ON the
# robot, matching the local layout — consumers derive the remote filename
# via `basename`, since the robot's own /userdata/valetudo/ stays flat
# regardless of how this checkout is organized).
PUSH_ITEMS=(
    "device/S96valetudo|exec"
    "device/karcher-cloud-switch.sh|exec"
    "device/boot-hook.sh|exec"
    "device/aiot-gate.sh|exec"
    "device/manage.sh|exec"
    "device/README.md|data"
    "server_v1.crt|data"
    "server.key|data"
)

# The three irreplaceable pre-Valetudo backups karcher-cloud-switch.sh's
# own ensure_backups() creates (HOSTS_BACKUP/CERT_BACKUP/GDROOT_BACKUP
# there — can't literally share those, different host/shell/script; rename
# one, rename both).
ORIG_BACKUP_FILES=(etc-hosts.orig server.crt.orig gdroot-g2.crt.orig)

# Runtime state under $REMOTE_DIR that install.sh must only ever report on,
# never create/overwrite.
RUNTIME_STATE_FILES=(config.json device-identity.json mode)

# report_runtime_state REMOTE
report_runtime_state() {
    ssh "${SSH_OPTS[@]}" "$1" "for f in ${RUNTIME_STATE_FILES[*]}; do
        if [ -f $REMOTE_DIR/\$f ]; then echo \"  \$f: present\"; else echo \"  \$f: absent\"; fi
    done"
}
