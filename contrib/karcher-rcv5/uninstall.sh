#!/bin/bash
#
# Full, safe reversion to stock. Ordered so a failure leaves the most
# recoverable state: the switch back to cloud mode happens first (and hard-
# fails with a pointer to restore-originals.sh if the on-device backups are
# missing), the boot hook is only removed after that succeeds, and --purge
# (opt-in, off by default) happens last. NEVER touches
# /userdata/{etc-hosts,server.crt,gdroot-g2.crt}.orig regardless of --purge —
# those are the irreplaceable originals, structurally outside /userdata/valetudo/.
#
# Within --purge, the /oem overlay is disarmed BEFORE /userdata/valetudo is
# removed — aiot-gate.sh overlay off only clears a flag (the actual revert to
# a stock read-only /oem happens on the next reboot), but it needs
# aiot-gate.sh to still be on disk to do even that. Purging first would leave
# /oem bind-mounted from the /userdata/debug_dir/oem copy indefinitely, with
# no script left on the robot able to undo it short of removing the flag file
# by hand over ssh.
#
# Usage: ./uninstall.sh <robot-ip-or-host> [--purge]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

HOST="${1:?usage: uninstall.sh <robot-ip-or-host> [--purge]}"
PURGE="${2:-}"
REMOTE="root@$HOST"

echo "== Switching back to stock cloud mode =="
if ! ssh "${SSH_OPTS[@]}" "$REMOTE" '/userdata/valetudo/karcher-cloud-switch.sh cloud'; then
    err "FAILED to restore stock cloud config — on-device backups are likely missing or corrupt."
    err "If you have Mac-side backups, run: ./restore-originals.sh $HOST"
    exit 1
fi

echo "== Reverting the wifi-deamon.sh aiot_client gate (if patched) =="
ssh "${SSH_OPTS[@]}" "$REMOTE" '[ -x /userdata/valetudo/aiot-gate.sh ] || exit 0
    grep -q "valetudo-gate BEGIN" /oem/bin/wifi-deamon.sh 2>/dev/null || exit 0
    /userdata/valetudo/aiot-gate.sh unpatch' \
    || warn "WARNING: could not revert the gate — check '/userdata/valetudo/aiot-gate.sh status' by hand"

echo "== Stopping Valetudo =="
ssh "${SSH_OPTS[@]}" "$REMOTE" '/userdata/valetudo/S96valetudo stop' || true

echo "== Removing boot-autostart hook =="
ssh "${SSH_OPTS[@]}" "$REMOTE" 'rm -f /userdata/cfg/rockchip_test/auto_reboot.sh'

if [ "$PURGE" = "--purge" ]; then
    echo "== Disarming the /oem overlay =="
    ssh "${SSH_OPTS[@]}" "$REMOTE" '[ -x /userdata/valetudo/aiot-gate.sh ] || exit 0
        /userdata/valetudo/aiot-gate.sh overlay off' \
        || warn "WARNING: could not disarm the overlay — check '/userdata/valetudo/aiot-gate.sh status' by hand"

    echo "== Removing any staged firmware upgrade image =="
    ssh "${SSH_OPTS[@]}" "$REMOTE" "rm -rf $REMOTE_STAGE_DIR"

    echo "== Purging /userdata/valetudo and the derived hosts variant =="
    ssh "${SSH_OPTS[@]}" "$REMOTE" 'rm -rf /userdata/valetudo; rm -f /userdata/etc-hosts.valetudo'
    echo "purged (the three .orig backups under /userdata were NOT touched)"
else
    echo "skipping purge (pass --purge to also remove /userdata/valetudo)"
fi

echo
echo "== Final state =="
ssh "${SSH_OPTS[@]}" "$REMOTE" '
    echo "  valetudo process running: $(pidof valetudo >/dev/null 2>&1 && echo yes || echo no)"
    echo "  boot hook present: $([ -f /userdata/cfg/rockchip_test/auto_reboot.sh ] && echo yes || echo no)"
    echo "  /userdata/valetudo present: $([ -d /userdata/valetudo ] && echo yes || echo no)"
    echo "  .orig backups present: $([ -f /userdata/etc-hosts.orig ] && [ -f /userdata/server.crt.orig ] && [ -f /userdata/gdroot-g2.crt.orig ] && echo yes || echo no)"
'

ok "uninstall.sh complete."
