#!/bin/bash
#
# Idempotent staging for a freshly-rooted RCV5: pushes the Valetudo binary,
# wrapper scripts, dev certs, an on-device README, and the boot trampoline. Never touches
# config.json/device-identity.json/mode if they already exist (those hold
# state this script has no business overwriting). Ends with the robot still
# in stock/cloud behavior — run activate.sh separately to switch it live.
#
# Runs on the Mac, drives the robot over ssh/scp. Usage: ./install.sh <robot-ip-or-host>
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKUP_DIR="$SCRIPT_DIR/device-originals-backup"
. "$SCRIPT_DIR/lib.sh"

HOST="${1:?usage: install.sh <robot-ip-or-host>}"
REMOTE="root@$HOST"
BINARY="$REPO_ROOT/build/armv7/valetudo"

[ -f "$BINARY" ] || { err "ERROR: $BINARY not found — build it first"; exit 1; }

echo "== Pre-flight =="
ssh "${SSH_OPTS[@]}" "$REMOTE" "command -v mkdir mv cmp cat >/dev/null" \
    || { err "ERROR: robot is missing an expected coreutils/busybox applet"; exit 1; }

# aiot-gate.sh's wifi-deamon.sh patch (and the rootfs analysis behind
# karcher-cloud-switch.sh) are anchored to exact strings/offsets in
# $EXPECTED_FIRMWARE and will refuse or silently misbehave on anything else.
# sysVersion.ini ships as part of the stock, read-only /oem, so it's always
# there to check — deliberately checked before touching anything else on the
# robot, not discovered later via a half-finished install or a mysteriously
# inert command.
ACTUAL_FIRMWARE="$(remote_firmware_version "$REMOTE")"
if [ "$ACTUAL_FIRMWARE" != "$EXPECTED_FIRMWARE" ]; then
    err "ERROR: firmware mismatch."
    err "  expected: $EXPECTED_FIRMWARE"
    err "  actual:   ${ACTUAL_FIRMWARE:-<unreadable — robot unreachable, or /oem/sysconf/sysVersion.ini missing/malformed>}"
    err "This tooling is anchored to $EXPECTED_FIRMWARE specifically (see aiot-gate.sh) and will refuse or silently misbehave on a different build. Do not proceed without reviewing this tooling against your actual firmware first."
    if [ -n "$ACTUAL_FIRMWARE" ]; then
        err "Run ./upgrade-firmware.sh $HOST to download, verify, and stage the correct firmware image (it does not flash automatically — see its own output for next steps)."
    fi
    exit 1
fi
echo "OK: firmware matches expected $EXPECTED_FIRMWARE"
if remote_oem_overlay_active "$REMOTE"; then
    warn "WARNING: /oem on $HOST is currently the aiot-gate.sh overlay bind-mount, not the"
    warn "live squashfs — the version just confirmed could be a stale snapshot rather than"
    warn "what's really flashed (overlay_on() re-arms an existing copy without refreshing"
    warn "it). If a firmware update happened while this was active, it may be masked. To be"
    warn "sure: ssh $REMOTE /userdata/valetudo/aiot-gate.sh overlay off   (then reboot)"
fi

AVAIL_KB=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "df /userdata | tail -1 | awk '{print \$4}'")
if [ "$AVAIL_KB" -lt 51200 ]; then
    err "ERROR: only ${AVAIL_KB}KB free on /userdata, need at least 50MB"
    exit 1
fi
echo "OK: ${AVAIL_KB}KB free on /userdata"

echo "== Pre-existing runtime state (never touched by this script) =="
report_runtime_state "$REMOTE"

ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p $REMOTE_DIR $REMOTE_TRAMPOLINE_DIR"

echo "== Pushing executables and dev certs =="
for item in "${PUSH_ITEMS[@]}"; do
    src="${item%%|*}"
    mode="${item#*|}"
    name="$(basename "$src")"
    scp "${SSH_OPTS[@]}" "$SCRIPT_DIR/$src" "$REMOTE:$REMOTE_DIR/$name.new"
    if [ "$mode" = exec ]; then
        ssh "${SSH_OPTS[@]}" "$REMOTE" "mv $REMOTE_DIR/$name.new $REMOTE_DIR/$name && chmod +x $REMOTE_DIR/$name"
    else
        ssh "${SSH_OPTS[@]}" "$REMOTE" "mv $REMOTE_DIR/$name.new $REMOTE_DIR/$name"
    fi
done

echo "== Pushing boot trampoline (sourced by the vendor's S99_auto_reboot) =="
scp "${SSH_OPTS[@]}" "$SCRIPT_DIR/device/auto_reboot.sh" "$REMOTE:$REMOTE_TRAMPOLINE.new"
ssh "${SSH_OPTS[@]}" "$REMOTE" "mv $REMOTE_TRAMPOLINE.new $REMOTE_TRAMPOLINE"
# Durable copy under /userdata/valetudo/, outside /data/cfg/ (which a GPIO recovery-key
# reset clears): aiot-gate.sh's deadline fallback restores the trampoline from here if
# a reset ever wipes the deployed copy above, without needing this laptop involved.
ssh "${SSH_OPTS[@]}" "$REMOTE" "cp $REMOTE_TRAMPOLINE $REMOTE_DIR/auto_reboot.sh"

echo "== Pushing + verifying Valetudo binary (34MB, may take a while) =="
scp "${SSH_OPTS[@]}" "$BINARY" "$REMOTE:$REMOTE_DIR/valetudo.new"
ssh "${SSH_OPTS[@]}" "$REMOTE" "mv $REMOTE_DIR/valetudo.new $REMOTE_DIR/valetudo && chmod +x $REMOTE_DIR/valetudo"
TMP_VERIFY="$(mktemp)"
trap 'rm -f "$TMP_VERIFY"' EXIT
scp "${SSH_OPTS[@]}" "$REMOTE:$REMOTE_DIR/valetudo" "$TMP_VERIFY"
if cmp -s "$BINARY" "$TMP_VERIFY"; then
    echo "OK: on-device binary matches $BINARY exactly"
else
    err "ERROR: on-device binary does NOT match local build — transfer likely corrupted, re-run install.sh"
    exit 1
fi

echo "== Ensuring irreplaceable backups exist on-device (robot stays fully stock — no mode change happens here) =="
ssh "${SSH_OPTS[@]}" "$REMOTE" "$REMOTE_DIR/karcher-cloud-switch.sh backup"

echo "== Pulling backups to $BACKUP_DIR (durable off-device copy, survives a factory reset) =="
mkdir -p "$BACKUP_DIR"
for name in "${ORIG_BACKUP_FILES[@]}"; do
    TMP_FETCH="$(mktemp)"
    scp "${SSH_OPTS[@]}" "$REMOTE:/userdata/$name" "$TMP_FETCH"
    if [ -f "$BACKUP_DIR/$name" ]; then
        if cmp -s "$BACKUP_DIR/$name" "$TMP_FETCH"; then
            echo "OK: $name matches existing local backup"
        else
            err "ERROR: $name from $HOST differs from the existing local backup at $BACKUP_DIR/$name — NOT overwriting."
            err "This usually means you're pointing at a different physical unit than the one that backup came from. Review both by hand."
            rm -f "$TMP_FETCH"
            exit 1
        fi
    else
        mv "$TMP_FETCH" "$BACKUP_DIR/$name"
        echo "saved: $BACKUP_DIR/$name"
    fi
    rm -f "$TMP_FETCH" 2>/dev/null || true
done

echo "== Pulling wifi-deamon.sh.orig if present (aiot-gate.sh patch's own backup) =="
if ssh "${SSH_OPTS[@]}" "$REMOTE" "[ -f /userdata/wifi-deamon.sh.orig ]"; then
    TMP_FETCH="$(mktemp)"
    scp "${SSH_OPTS[@]}" "$REMOTE:/userdata/wifi-deamon.sh.orig" "$TMP_FETCH"
    if [ -f "$BACKUP_DIR/wifi-deamon.sh.orig" ]; then
        if cmp -s "$BACKUP_DIR/wifi-deamon.sh.orig" "$TMP_FETCH"; then
            echo "OK: wifi-deamon.sh.orig matches existing local backup"
        else
            err "ERROR: wifi-deamon.sh.orig from $HOST differs from the existing local backup at $BACKUP_DIR/wifi-deamon.sh.orig — NOT overwriting."
            err "This usually means you're pointing at a different physical unit than the one that backup came from. Review both by hand."
            rm -f "$TMP_FETCH"
            exit 1
        fi
    else
        mv "$TMP_FETCH" "$BACKUP_DIR/wifi-deamon.sh.orig"
        echo "saved: $BACKUP_DIR/wifi-deamon.sh.orig"
    fi
    rm -f "$TMP_FETCH" 2>/dev/null || true
else
    echo "not yet present on-device (aiot-gate.sh patch hasn't run there yet) — nothing to pull"
fi

echo "== Post-install runtime state (should be unchanged from pre-existing) =="
report_runtime_state "$REMOTE"

echo
ok "install.sh complete. Robot is still in stock/cloud mode — nothing has been redirected."
ok "Run ./activate.sh $HOST when you're ready to switch it into valetudo mode."
