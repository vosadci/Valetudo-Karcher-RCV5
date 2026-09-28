#!/bin/bash
#
# Disaster recovery: pushes the three irreplaceable .orig backups from
# device-originals-backup/ back onto a robot whose /userdata was wiped
# (factory reset) or is otherwise missing them. Run this, then
# karcher-cloud-switch.sh cloud (should be a no-op if already stock) or
# install.sh + activate.sh to re-provision from scratch.
#
# Usage: ./restore-originals.sh <robot-ip-or-host>
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR/device-originals-backup"
. "$SCRIPT_DIR/lib.sh"

HOST="${1:?usage: restore-originals.sh <robot-ip-or-host>}"
REMOTE="root@$HOST"

for name in "${ORIG_BACKUP_FILES[@]}"; do
    [ -f "$BACKUP_DIR/$name" ] || { err "ERROR: $BACKUP_DIR/$name not found — nothing to restore"; exit 1; }
done

for name in "${ORIG_BACKUP_FILES[@]}"; do
    scp "${SSH_OPTS[@]}" "$BACKUP_DIR/$name" "$REMOTE:/userdata/$name"
done

ok "originals restored to /userdata on $HOST"
ok "next: ssh $REMOTE /userdata/valetudo/karcher-cloud-switch.sh cloud (should be a no-op if already stock)"
ok "      or ./install.sh $HOST to re-provision Valetudo from scratch"
