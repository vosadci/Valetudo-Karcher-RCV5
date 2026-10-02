#!/bin/bash
#
# Manual, standalone — never invoked by install.sh/activate.sh. Downloads and
# md5-verifies the official Kärcher RCV5 firmware image on the Mac, checks
# /userdata space on the robot, and stages the verified image at a NEUTRAL
# path — deliberately NOT /userdata/Download/update.img, the plausible
# auto-watched location per strings/symbol analysis of /oem/bin/upgrade and
# RobotApp (see README.md "Updating firmware" for the full research
# writeup). Stops there. Actually flashing it is a separate, manual,
# UNVERIFIED step this script does not attempt.
#
# Runs on the Mac, drives the robot over ssh/scp. Usage: ./upgrade-firmware.sh <robot-ip-or-host>
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

HOST="${1:?usage: upgrade-firmware.sh <robot-ip-or-host>}"
REMOTE="root@$HOST"

DOWNLOAD_DIR="$HOME/Downloads/Karcher app-FW"
LOCAL_IMAGE="$DOWNLOAD_DIR/Kaercher_RCV5_EU-$EXPECTED_FIRMWARE.img"
REMOTE_IMAGE="$REMOTE_STAGE_DIR/$(basename "$LOCAL_IMAGE")"

echo "== Pre-flight =="
ssh "${SSH_OPTS[@]}" "$REMOTE" "command -v md5sum df awk mkdir mv rm du >/dev/null" \
    || { err "ERROR: robot is missing an expected coreutils/busybox applet"; exit 1; }

echo "== Checking current firmware on $HOST =="
ACTUAL_FIRMWARE="$(remote_firmware_version "$REMOTE")"
ACTUAL_CODE="$(remote_firmware_code "$REMOTE")"
if [ -z "$ACTUAL_FIRMWARE" ] || [ -z "$ACTUAL_CODE" ]; then
    err "ERROR: could not read firmware version from $HOST — unreachable, or /oem/sysconf/sysVersion.ini missing/malformed."
    exit 1
fi

if remote_oem_overlay_active "$REMOTE"; then
    warn "WARNING: /oem on $HOST is currently the aiot-gate.sh overlay bind-mount, not the"
    warn "live squashfs — the version below could be a stale snapshot rather than what's"
    warn "really flashed (overlay_on() re-arms an existing copy without refreshing it)."
    warn "If a firmware update already happened while this was active, it may be masked."
    warn "To be sure: ssh $REMOTE /userdata/valetudo/aiot-gate.sh overlay off   (then reboot)"
    warn "and re-run this script before trusting the result below."
fi

case "$ACTUAL_CODE" in
    ''|*[!0-9]*)
        err "ERROR: sysVersionCode '$ACTUAL_CODE' on $HOST isn't a plain number — refusing to guess whether this needs upgrading."
        exit 1
        ;;
esac

echo "Current: $ACTUAL_FIRMWARE (code $ACTUAL_CODE)   Target: $EXPECTED_FIRMWARE (code $EXPECTED_FIRMWARE_CODE)"

if [ "$ACTUAL_CODE" -eq "$EXPECTED_FIRMWARE_CODE" ]; then
    if [ "$ACTUAL_FIRMWARE" != "$EXPECTED_FIRMWARE" ]; then
        # Code matches but the string doesn't (or vice versa, caught by
        # install.sh's own string-only check) — sysVersion.ini is
        # internally inconsistent. Refuse rather than trust either field
        # alone; this is exotic enough that guessing isn't warranted.
        err "ERROR: sysVersion.ini is inconsistent on $HOST — sysVersionCode matches"
        err "$EXPECTED_FIRMWARE_CODE but sysVersion reads '$ACTUAL_FIRMWARE', not '$EXPECTED_FIRMWARE'."
        err "Refusing to guess which field to trust. Check /oem/sysconf/sysVersion.ini by hand."
        exit 1
    fi
    warn "WARNING: $HOST is already on $EXPECTED_FIRMWARE — nothing to do."
    exit 0
fi
if [ "$ACTUAL_CODE" -gt "$EXPECTED_FIRMWARE_CODE" ]; then
    err "ERROR: $HOST reports firmware code $ACTUAL_CODE, NEWER than this tooling's target"
    err "($EXPECTED_FIRMWARE, code $EXPECTED_FIRMWARE_CODE). Staging an older image would be a"
    err "downgrade, and this tooling (aiot-gate.sh's patch above all) hasn't been re-verified"
    err "against that newer build. Refusing rather than guess."
    exit 1
fi

echo "== Checking for an already-staged image on $HOST =="
# Clean up any half-finished prior attempt before measuring/deciding, so a
# leftover .new can't cause a false "not enough space" read.
ssh "${SSH_OPTS[@]}" "$REMOTE" "rm -f $REMOTE_IMAGE.new"
STAGED_MD5=""
if ssh "${SSH_OPTS[@]}" "$REMOTE" "[ -f $REMOTE_IMAGE ]"; then
    STAGED_MD5="$(ssh "${SSH_OPTS[@]}" "$REMOTE" "md5sum $REMOTE_IMAGE 2>/dev/null | awk '{print \$1}'" || true)"
    if [ "$STAGED_MD5" != "$FIRMWARE_MD5" ]; then
        warn "WARNING: existing staged image at $REMOTE_IMAGE has the wrong md5 — removing it."
        ssh "${SSH_OPTS[@]}" "$REMOTE" "rm -f $REMOTE_IMAGE"
        STAGED_MD5=""
    fi
fi

if [ "$STAGED_MD5" = "$FIRMWARE_MD5" ]; then
    echo "OK: a verified image is already staged — skipping the space check."
else
    echo "== Checking /userdata free space on $HOST =="
    AVAIL_KB=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "df /userdata | tail -1 | awk '{print \$4}'")
    NEED_KB=$(( FIRMWARE_SIZE_BYTES / 1024 + 20480 ))
    if [ "$AVAIL_KB" -lt "$NEED_KB" ]; then
        SHORT_KB=$((NEED_KB - AVAIL_KB))
        err "ERROR: only ${AVAIL_KB}KB free on /userdata, need at least ${NEED_KB}KB (image size + 20MB headroom, same margin aiot-gate.sh's own overlay_on() uses) — short by ${SHORT_KB}KB."

        RECLAIM_KB=0
        if ssh "${SSH_OPTS[@]}" "$REMOTE" "[ -d /userdata/valetudo ]"; then
            V_KB=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "du -sk /userdata/valetudo | awk '{print \$1}'")
            RECLAIM_KB=$((RECLAIM_KB + V_KB))
            err "  /userdata/valetudo is present (~${V_KB}KB) — './uninstall.sh $HOST --purge' would reclaim that."
        fi
        if ssh "${SSH_OPTS[@]}" "$REMOTE" "[ -d /userdata/debug_dir/oem ]"; then
            O_KB=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "du -sk /userdata/debug_dir/oem 2>/dev/null | awk '{print \$1}'" || echo 0)
            RECLAIM_KB=$((RECLAIM_KB + O_KB))
            err "  aiot-gate.sh's /oem overlay copy is present (~${O_KB}KB) — the bigger lever, but"
            err "  more disruptive: 'aiot-gate.sh overlay off' undoes the wifi-deamon.sh gate AND"
            err "  the cert swap, not a casual toggle. Only worth it if valetudo mode isn't needed"
            err "  right now. See README.md 'Updating firmware'."
        fi
        if [ "$RECLAIM_KB" -gt 0 ] && [ "$RECLAIM_KB" -lt "$SHORT_KB" ]; then
            err "  NOTE: reclaiming the above (~${RECLAIM_KB}KB total) is NOT enough by itself — still short by $((SHORT_KB - RECLAIM_KB))KB."
        fi
        exit 1
    fi
    echo "OK: ${AVAIL_KB}KB free on /userdata"
fi

echo "== Fetching firmware image =="
mkdir -p "$DOWNLOAD_DIR"
if [ -f "$LOCAL_IMAGE" ] && [ "$(local_md5 "$LOCAL_IMAGE")" = "$FIRMWARE_MD5" ]; then
    echo "OK: already have a verified copy at $LOCAL_IMAGE"
else
    if [ -f "$LOCAL_IMAGE" ]; then
        warn "WARNING: existing $LOCAL_IMAGE has the wrong md5 — re-downloading."
    fi
    echo "Downloading $FIRMWARE_URL (~100MB, may take a while)..."
    curl -fL --progress-bar -o "$LOCAL_IMAGE.new" "$FIRMWARE_URL" \
        || { err "ERROR: download failed. If this is a 404, the vendor may have rotated this URL — see the comment above FIRMWARE_URL in lib.sh."; rm -f "$LOCAL_IMAGE.new"; exit 1; }
    DOWNLOADED_MD5="$(local_md5 "$LOCAL_IMAGE.new")"
    if [ "$DOWNLOADED_MD5" != "$FIRMWARE_MD5" ]; then
        err "ERROR: downloaded image md5 mismatch (expected $FIRMWARE_MD5, got $DOWNLOADED_MD5) — NOT saving. Do not proceed."
        rm -f "$LOCAL_IMAGE.new"
        exit 1
    fi
    mv "$LOCAL_IMAGE.new" "$LOCAL_IMAGE"
    echo "OK: downloaded and verified: $LOCAL_IMAGE"
fi

if [ "$STAGED_MD5" = "$FIRMWARE_MD5" ]; then
    echo "== Already staged and verified on $HOST =="
else
    echo "== Staging on $HOST (neutral path — nothing auto-watches it, no trigger happens) =="
    ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p $REMOTE_STAGE_DIR"
    scp "${SSH_OPTS[@]}" "$LOCAL_IMAGE" "$REMOTE:$REMOTE_IMAGE.new"
    ssh "${SSH_OPTS[@]}" "$REMOTE" "mv $REMOTE_IMAGE.new $REMOTE_IMAGE"

    echo "== Verifying integrity on-device =="
    REMOTE_MD5="$(ssh "${SSH_OPTS[@]}" "$REMOTE" "md5sum $REMOTE_IMAGE | awk '{print \$1}'")"
    if [ "$REMOTE_MD5" != "$FIRMWARE_MD5" ]; then
        err "ERROR: on-device md5 does not match — transfer likely corrupted. Re-run this script."
        exit 1
    fi
    echo "OK: on-device image matches ($REMOTE_MD5)"
fi

echo
ok "upgrade-firmware.sh complete. Verified firmware image staged at:"
ok "  $HOST:$REMOTE_IMAGE"
ok "Nothing has been flashed. Full detail: README.md 'Updating firmware'. Two options:"
echo
echo "  (a) Via the official Kärcher app (untested here) — pair through it (offers a firmware"
echo "      update as part of that flow). First, free the space back up:"
echo "        ssh $REMOTE rm -rf $REMOTE_STAGE_DIR"
echo "      Then make the robot reachable by the real app again. If you got here because"
echo "      install.sh refused (the most likely case), karcher-cloud-switch.sh isn't on the"
echo "      robot yet, so there's nothing to switch — it's stock/cloud already. If Valetudo"
echo "      IS installed and in valetudo mode, switch it back first:"
echo "        ssh $REMOTE /userdata/valetudo/karcher-cloud-switch.sh cloud"
echo "      Then see 'Recovering from a WiFi/config reset' in README.md."
echo
echo "  (b) ON HOLD, NOT TESTED — a local trigger for /oem/bin/upgrade's own OTA daemon"
echo "      has been fully mapped by disassembly (Unix-domain-socket message, exact byte"
echo "      layout known), but testing it live is on hold: there's no known way to"
echo "      revert this robot's firmware first, so a live attempt would be the first"
echo "      real test of a write path with no confirmed way back. Full writeup and"
echo "      current status: README.md 'Updating firmware' -> 'Local OTA trigger (on hold)'."
