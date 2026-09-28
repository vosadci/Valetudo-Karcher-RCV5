#!/bin/bash
#
# Explicit, separate switch-on step — kept apart from install.sh so re-running
# install.sh (e.g. to push an updated binary) never risks flipping an
# already-provisioned robot's live mode by accident. Idempotent: safe to
# re-run at any time.
#
# /oem is read-only squashfs unless bind-mounted from a userdata-backed
# overlay (see aiot-gate.sh) — switching into valetudo mode needs to write
# there (cert swap, wifi-deamon.sh patch). This script arms that overlay
# itself when it isn't already armed, which needs one reboot the very first
# time (or after aiot-gate.sh overlay off / a factory reset) — everything
# after that is a normal no-reboot run.
#
# Also applies the aiot-gate.sh patch itself (idempotent) before switching
# into valetudo mode, closing the boot-time window where aiot_client could
# still reach the real cloud before our redirect took effect. A firmware
# this wasn't written against fails the patch's anchor check and aborts this
# script (set -e) rather than activating with that window still open.
#
# Usage: ./activate.sh <robot-ip-or-host>
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

HOST="${1:?usage: activate.sh <robot-ip-or-host>}"
REMOTE="root@$HOST"

oem_writable() {
    ssh "${SSH_OPTS[@]}" "$REMOTE" \
        'probe="/oem/sysconf/.valetudo-rwtest.$$"; touch "$probe" 2>/dev/null && rm -f "$probe"'
}

wait_for_reboot() {
    echo "Waiting for $HOST to come back up..."
    for i in $(seq 1 60); do
        sleep 5
        # No BatchMode here deliberately: the ControlMaster session was just
        # closed below, so this needs to be able to prompt for the root
        # password again once the robot is actually reachable. BatchMode=yes
        # would silently refuse that prompt and this loop would never
        # succeed, no matter how long the robot's been back up.
        if ssh -o ConnectTimeout=3 "${SSH_OPTS[@]}" "$REMOTE" true 2>/dev/null; then
            echo "Robot is back."
            return 0
        fi
    done
    err "ERROR: robot did not come back within 5 minutes of reboot — check it manually."
    exit 1
}

if ! oem_writable; then
    echo "== /oem overlay not armed yet — arming it now (one-time, needs a reboot) =="
    ssh "${SSH_OPTS[@]}" "$REMOTE" '/userdata/valetudo/aiot-gate.sh overlay on'
    echo "Rebooting $HOST..."
    ssh "${SSH_OPTS[@]}" "$REMOTE" reboot || true
    # The reboot kills the remote sshd mid-connection, leaving the ControlMaster
    # socket stale — close it explicitly (bounded, so a half-dead connection
    # can't hang this) so the wait loop below always opens a genuinely fresh
    # connection rather than hitting a dead multiplexed socket.
    ssh -o ConnectTimeout=3 -O exit "${SSH_OPTS[@]}" "$REMOTE" 2>/dev/null || true
    echo "You may be prompted for the root password again below — the connection"
    echo "above was lost when the robot rebooted."
    wait_for_reboot
fi

# Closes the S90->S99 boot-time window where aiot_client could still reach the
# real cloud (see aiot-gate.sh). check_anchors() inside it refuses to patch a
# wifi-deamon.sh it doesn't recognize rather than guessing — `set -e` above
# means that failure aborts this script here, before valetudo mode is ever
# switched on, instead of silently leaving the race open.
echo "== Closing the boot-time cloud-contact window =="
ssh "${SSH_OPTS[@]}" "$REMOTE" '/userdata/valetudo/aiot-gate.sh patch'

ssh "${SSH_OPTS[@]}" "$REMOTE" '/userdata/valetudo/S96valetudo start'
sleep 2
ssh "${SSH_OPTS[@]}" "$REMOTE" '/userdata/valetudo/karcher-cloud-switch.sh valetudo'

ok "activated valetudo mode on $HOST — verify the map/controls work at http://$HOST"
ok "undo with: ssh $REMOTE /userdata/valetudo/karcher-cloud-switch.sh cloud"
