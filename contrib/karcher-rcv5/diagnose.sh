#!/bin/bash
#
# Read-only inventory of everything this toolkit touches on the robot:
# firmware, disk space, every pushed file, runtime state, the irreplaceable
# backups, karcher-cloud-switch.sh's and aiot-gate.sh's own status
# reporting, process liveness, any staged firmware image, and known vendor
# flags. Never scp/mv/rm/mount/chmod's anything on the robot — only ssh
# read commands (cat/md5sum/df/du/pidof/mountpoint -q/grep -q/etc.) and
# local file reads. Safe to run against a robot in any state, including one
# that's never been provisioned or was just reset.
#
# Cross-checks the mode file against the actual live state (hosts/cert
# source, aiot-gate.sh patch, valetudo process) — only flags a mismatch,
# never the mode itself: mode=cloud with everything else stock is a valid,
# deliberate state, not a problem. Field values are parsed out of
# karcher-cloud-switch.sh's/aiot-gate.sh's own relayed status text (see
# field_of()) rather than re-derived here, so this can't drift from how
# those scripts actually compute them.
#
# Runs on the Mac, drives the robot over ssh. Usage: ./diagnose.sh <robot-ip-or-host>
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKUP_DIR="$SCRIPT_DIR/device-originals-backup"
. "$SCRIPT_DIR/lib.sh"

HOST="${1:?usage: diagnose.sh <robot-ip-or-host>}"
REMOTE="root@$HOST"

ISSUES=0
# Pushed-file/trampoline/backup absence specifically ("not installed yet")
# is tracked separately from everything else — see the Summary section,
# which only folds this into ISSUES/the exit code once it's determined the
# robot isn't just legitimately fresh/unprovisioned.
INSTALL_ISSUES=0
# ISSUE lines are this script's whole point — print them to stdout (not
# lib.sh's warn(), which is stderr), so `diagnose.sh <ip> > report.txt`
# doesn't silently drop every finding from the saved file.
print_issue() {
    printf '%s%s%s\n' "$BOLD$MAGENTA" "  ISSUE: $*" "$RESET"
}
flag() {
    ISSUES=$((ISSUES + 1))
    print_issue "$@"
}
flag_install() {
    INSTALL_ISSUES=$((INSTALL_ISSUES + 1))
    print_issue "$@"
}
section() {
    echo
    echo "== $* =="
}

# field_of TEXT LABEL — pulls the value after "LABEL : " out of a
# mode_status()-style report (karcher-cloud-switch.sh's/aiot-gate.sh's own
# status output, captured verbatim, not re-derived here) so a handful of
# fields can be cross-checked without duplicating how those scripts compute
# them. `|` as the sed delimiter since some labels contain `/`.
field_of() {
    printf '%s\n' "$1" | sed -n "s|^$2[[:space:]]*:[[:space:]]*||p" | head -1
}

# remote_md5 REMOTE_PATH — empty string if absent/unreadable, never fails
# the script (set -e safe: always ends in `|| true`).
remote_md5() {
    ssh "${SSH_OPTS[@]}" "$REMOTE" "md5sum '$1' 2>/dev/null" | awk '{print $1}' || true
}

# json_valid CONTENT -> valid|invalid|empty. Validated locally rather than
# assuming a JSON tool is callable on the robot's busybox — Node is already
# a hard requirement of this repo's own build, and we already fetch the
# content once for display, so this is free.
json_valid() {
    [ -n "$1" ] || { echo "empty"; return; }
    if printf '%s' "$1" | node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))" >/dev/null 2>&1; then
        echo "valid"
    else
        echo "invalid"
    fi
}

section "Reachability"
if ! ssh -o ConnectTimeout=5 "${SSH_OPTS[@]}" "$REMOTE" true; then
    err "ERROR: cannot reach $HOST over ssh"
    exit 1
fi
ok "OK: $HOST reachable"

section "Firmware"
ACTUAL_FIRMWARE="$(remote_firmware_version "$REMOTE")"
ACTUAL_CODE="$(remote_firmware_code "$REMOTE")"
echo "current  : ${ACTUAL_FIRMWARE:-<unreadable>} (code ${ACTUAL_CODE:-?})"
echo "expected : $EXPECTED_FIRMWARE (code $EXPECTED_FIRMWARE_CODE)"
if [ "$ACTUAL_FIRMWARE" != "$EXPECTED_FIRMWARE" ]; then
    flag "firmware mismatch — see ./upgrade-firmware.sh"
fi
if remote_oem_overlay_active "$REMOTE"; then
    warn "  NOTE: /oem is the aiot-gate.sh overlay bind-mount — the version above could be"
    warn "  a stale snapshot rather than what's really flashed (see README 'Updating firmware')."
fi

section "Disk space (df -hT)"
ssh "${SSH_OPTS[@]}" "$REMOTE" "df -hT / /userdata /tmp /robotconf 2>/dev/null" || true

section "Pushed files vs. local checkout (md5)"
MISSING_PUSH_COUNT=0
TOTAL_PUSH_COUNT=${#PUSH_ITEMS[@]}
for item in "${PUSH_ITEMS[@]}"; do
    src="${item%%|*}"
    name="$(basename "$src")"
    local_sum="$(local_md5 "$SCRIPT_DIR/$src")"
    remote_sum="$(remote_md5 "$REMOTE_DIR/$name")"
    if [ -z "$remote_sum" ]; then
        echo "$name : absent on device"
        flag_install "$name not present on device"
        MISSING_PUSH_COUNT=$((MISSING_PUSH_COUNT + 1))
    elif [ -z "$local_sum" ]; then
        echo "$name : present on device, no local copy to compare against ($SCRIPT_DIR/$src)"
    elif [ "$remote_sum" = "$local_sum" ]; then
        echo "$name : matches local checkout"
    else
        echo "$name : DIFFERS from local checkout ($SCRIPT_DIR/$src)"
        flag "$name on device differs from the local working tree"
    fi
done

# Checked regardless of whether a local build exists (unlike before — a
# missing binary used to only get noticed when comparing against one),
# since "does it exist at all" and "does it match my local build" are two
# different questions.
BINARY_PRESENT=yes
remote_sum="$(remote_md5 "$REMOTE_DIR/valetudo")"
if [ -z "$remote_sum" ]; then
    BINARY_PRESENT=no
    echo "valetudo binary : absent on device"
    flag_install "valetudo binary not present on device"
elif [ -f "$REPO_ROOT/build/armv7/valetudo" ]; then
    local_sum="$(local_md5 "$REPO_ROOT/build/armv7/valetudo")"
    if [ "$remote_sum" = "$local_sum" ]; then
        echo "valetudo binary : matches local build"
    else
        echo "valetudo binary : DIFFERS from local build"
        flag "valetudo binary on device differs from the local build"
    fi
else
    echo "valetudo binary : present on device, no local build at $REPO_ROOT/build/armv7/valetudo to compare against"
fi

section "Boot trampoline"
local_sum="$(local_md5 "$SCRIPT_DIR/device/auto_reboot.sh")"
t1="$(remote_md5 "$REMOTE_TRAMPOLINE")"
t2="$(remote_md5 "$REMOTE_DIR/auto_reboot.sh")"
if [ -z "$t1" ]; then
    echo "$REMOTE_TRAMPOLINE : absent"
    flag_install "boot trampoline absent at $REMOTE_TRAMPOLINE — robot will NOT auto-switch on boot"
elif [ -z "$local_sum" ]; then
    echo "$REMOTE_TRAMPOLINE : present, no local copy to compare against"
elif [ "$t1" = "$local_sum" ]; then
    echo "$REMOTE_TRAMPOLINE : present, matches local checkout"
else
    echo "$REMOTE_TRAMPOLINE : present, DIFFERS from local checkout"
    flag "$REMOTE_TRAMPOLINE differs from the local checkout"
fi
if [ -z "$t2" ]; then
    echo "$REMOTE_DIR/auto_reboot.sh : absent (durable copy missing)"
    flag_install "durable trampoline copy absent at $REMOTE_DIR/auto_reboot.sh"
elif [ -z "$local_sum" ]; then
    echo "$REMOTE_DIR/auto_reboot.sh : present, no local copy to compare against"
elif [ "$t2" = "$local_sum" ]; then
    echo "$REMOTE_DIR/auto_reboot.sh : present, matches local checkout"
else
    echo "$REMOTE_DIR/auto_reboot.sh : present, DIFFERS from local checkout"
    flag "$REMOTE_DIR/auto_reboot.sh differs from the local checkout"
fi

section "Runtime state ($REMOTE_DIR)"
report_runtime_state "$REMOTE"
echo "device-identity.json content:"
IDENTITY_CONTENT="$(ssh "${SSH_OPTS[@]}" "$REMOTE" "cat $REMOTE_DIR/device-identity.json 2>/dev/null" || true)"
if [ -n "$IDENTITY_CONTENT" ]; then
    echo "$IDENTITY_CONTENT" | sed 's/^/  /'
    [ "$(json_valid "$IDENTITY_CONTENT")" = invalid ] && flag "device-identity.json is present but not valid JSON"
else
    echo "  (absent)"
fi
CONFIG_CONTENT="$(ssh "${SSH_OPTS[@]}" "$REMOTE" "cat $REMOTE_DIR/config.json 2>/dev/null" || true)"
if [ -n "$CONFIG_CONTENT" ] && [ "$(json_valid "$CONFIG_CONTENT")" = invalid ]; then
    flag "config.json is present but not valid JSON"
fi

section "Irreplaceable backups"
for name in "${ORIG_BACKUP_FILES[@]}"; do
    remote_sum="$(remote_md5 "/userdata/$name")"
    if [ -z "$remote_sum" ]; then
        echo "$name : absent on device"
        flag_install "$name missing on device — irreplaceable if lost"
        continue
    fi
    if [ -f "$BACKUP_DIR/$name" ]; then
        local_sum="$(local_md5 "$BACKUP_DIR/$name")"
        if [ "$local_sum" = "$remote_sum" ]; then
            echo "$name : present on device, matches Mac backup"
        else
            echo "$name : present on device, DIFFERS from Mac backup at $BACKUP_DIR/$name"
            flag "$name differs between device and Mac backup — investigate before trusting either"
        fi
    else
        echo "$name : present on device, no Mac-side backup at $BACKUP_DIR/$name yet"
        flag "$name has no Mac-side backup — run install.sh to pull one"
    fi
done
if ssh "${SSH_OPTS[@]}" "$REMOTE" "[ -f /userdata/wifi-deamon.sh.orig ]"; then
    echo "wifi-deamon.sh.orig : present"
else
    echo "wifi-deamon.sh.orig : absent (aiot-gate.sh patch hasn't run yet)"
fi

section "karcher-cloud-switch.sh status (relayed from local checkout — on-device copy not touched or trusted)"
CCS_STATUS="$(ssh "${SSH_OPTS[@]}" "$REMOTE" sh -s status < "$SCRIPT_DIR/device/karcher-cloud-switch.sh" 2>&1)" \
    || flag "karcher-cloud-switch.sh status check failed to run"
echo "$CCS_STATUS" | sed 's/^/  /'

# ensure_backups() (on the robot) only ever checks [ -f ... ] before
# deciding not to recreate a backup — it never re-verifies an EXISTING
# one's content, so a truncated/corrupted-but-present file would look fine
# there forever. The "Irreplaceable backups" section above only catches
# that when a Mac-side copy exists to compare against; this catches it
# even without one, using the sanity check karcher-cloud-switch.sh's own
# status just reported (non-empty + BEGIN CERTIFICATE for the two certs).
# Doesn't re-flag "absent" — that's already covered above.
for name in "${ORIG_BACKUP_FILES[@]}"; do
    state="$(field_of "$CCS_STATUS" "backup: /userdata/$name")"
    case "$state" in
        *EMPTY*|*"does NOT look"*)
            flag "/userdata/$name is present but looks corrupt on-device: $state"
            ;;
    esac
done

# A real bug this project hit live once (switch_hosts()'s own comment):
# mountpoint gives false negatives for this FILE bind mount, so a stale
# layer from an earlier run can silently stack instead of being replaced.
# mode_status() already counts them; this is the first place that acts on it.
hosts_layers="$(field_of "$CCS_STATUS" "/etc/hosts bind layers")"
case "$hosts_layers" in
    *STACKED*)
        flag "/etc/hosts has stacked bind-mount layers ($hosts_layers) — see switch_hosts() in karcher-cloud-switch.sh"
        ;;
esac

section "aiot-gate.sh status (relayed from local checkout)"
AG_STATUS="$(ssh "${SSH_OPTS[@]}" "$REMOTE" sh -s status < "$SCRIPT_DIR/device/aiot-gate.sh" 2>&1)" \
    || flag "aiot-gate.sh status check failed to run"
echo "$AG_STATUS" | sed 's/^/  /'

section "Processes"
VALETUDO_RUNNING=no
if ssh "${SSH_OPTS[@]}" "$REMOTE" "pidof valetudo >/dev/null 2>&1"; then
    echo "valetudo : running"
    VALETUDO_RUNNING=yes
else
    echo "valetudo : not running"
fi

section "Consistency (mode file vs. actual live state)"
MODE="$(field_of "$CCS_STATUS" "mode file")"
HOSTS_SOURCE="$(field_of "$CCS_STATUS" "/etc/hosts source")"
GATE_STATE="$(field_of "$AG_STATUS" "live /oem gate")"
AIOT_STATE="$(field_of "$AG_STATUS" "aiot_client.bin")"
echo "mode file reports: ${MODE:-<unknown>}"
if [ "$AIOT_STATE" != "running" ]; then
    flag "aiot_client.bin is not running — robot is not talking to any cloud, real or local"
fi
if [ "$MODE" = "valetudo" ]; then
    if [ "$HOSTS_SOURCE" != "valetudo" ]; then
        flag "mode file says valetudo but /etc/hosts source is '${HOSTS_SOURCE:-<unknown>}', not valetudo"
    fi
    if [ "$GATE_STATE" != "PATCHED" ]; then
        flag "mode file says valetudo but the aiot-gate.sh wifi-deamon.sh patch is not applied"
    fi
    if [ "$VALETUDO_RUNNING" != "yes" ]; then
        flag "mode file says valetudo but the valetudo process is not running"
    fi
elif [ "$HOSTS_SOURCE" = "valetudo" ]; then
    flag "mode file says '${MODE:-<unknown>}' (not valetudo) but /etc/hosts is still redirected to the valetudo dummycloud"
else
    echo "not in valetudo mode — hosts/gate/process cross-checks above don't apply"
fi

section "Staged firmware upgrade image"
STAGE_LISTING="$(ssh "${SSH_OPTS[@]}" "$REMOTE" "
    [ -d $REMOTE_STAGE_DIR ] || exit 0
    for f in $REMOTE_STAGE_DIR/*.img; do
        [ -f \"\$f\" ] || continue
        sum=\$(md5sum \"\$f\" | awk '{print \$1}')
        if [ \"\$sum\" = \"$FIRMWARE_MD5\" ]; then
            echo \"\$f : verified (matches expected \$sum)\"
        else
            echo \"\$f : md5 \$sum (does NOT match expected $FIRMWARE_MD5)\"
        fi
    done
" || true)"
if [ -n "$STAGE_LISTING" ]; then
    echo "$STAGE_LISTING"
else
    echo "(no staged image)"
fi

section "Vendor flags"
if ssh "${SSH_OPTS[@]}" "$REMOTE" "[ -f /userdata/debug_mode ]"; then
    echo "/userdata/debug_mode (vendor SSH/ADB gate) : present"
else
    echo "/userdata/debug_mode (vendor SSH/ADB gate) : ABSENT — root SSH/ADB access may stop working"
    flag "vendor debug_mode flag absent"
fi

section "Logs"
if ssh "${SSH_OPTS[@]}" "$REMOTE" "[ -f /tmp/valetudo.log ]"; then
    LINES="$(ssh "${SSH_OPTS[@]}" "$REMOTE" "wc -l < /tmp/valetudo.log" || echo '?')"
    echo "/tmp/valetudo.log : present, $LINES lines"
else
    echo "/tmp/valetudo.log : absent (ephemeral — expected after any reboot)"
fi
if ssh "${SSH_OPTS[@]}" "$REMOTE" "[ -f /tmp/valetudo-boot-hook.log ]"; then
    echo "/tmp/valetudo-boot-hook.log:"
    ssh "${SSH_OPTS[@]}" "$REMOTE" "cat /tmp/valetudo-boot-hook.log" | sed 's/^/  /'
else
    echo "/tmp/valetudo-boot-hook.log : absent (ephemeral — expected after any reboot)"
fi
# `|| true` (not `|| echo 0`): grep -c already prints "0" itself on a
# zero-match search of an existing file, but also exits 1 (making the ssh
# call itself "fail") for that — `|| echo 0` used to add a SECOND "0" line
# on top. `${:-0}` covers the file-genuinely-absent case (grep prints
# nothing then). Same fix as karcher-cloud-switch.sh's hosts_layers.
GATE_DEADLINE_COUNT="$(ssh "${SSH_OPTS[@]}" "$REMOTE" "grep -c 'valetudo-gate deadline' /userdata/log/miio_deamon.log 2>/dev/null" || true)"
echo "gate-deadline fallback events (vendor's own miio_deamon.log) : ${GATE_DEADLINE_COUNT:-0}"

section "Summary"
# A presentation-layer label only — combines facts already extracted above
# from karcher-cloud-switch.sh's/aiot-gate.sh's own status output. Doesn't
# re-derive what any of those facts mean; karcher-cloud-switch.sh/
# aiot-gate.sh remain the one source of truth for that.
#
# STATE is computed independently of file-completeness now (it used to
# short-circuit to a blanket "PARTIAL install" the moment ANY pushed file
# was missing — which fired on every already-healthy, already-activated
# robot the day manage.sh was added to PUSH_ITEMS, since old installs
# never got it pushed). The two are reported separately below instead.
FRESH=no
if [ "$MISSING_PUSH_COUNT" -eq "$TOTAL_PUSH_COUNT" ] && [ "$BINARY_PRESENT" = no ]; then
    STATE="stock — not provisioned"
    FRESH=yes
elif [ "$MODE" = "valetudo" ]; then
    if [ "$HOSTS_SOURCE" = "valetudo" ] && [ "$GATE_STATE" = "PATCHED" ] \
       && [ "$VALETUDO_RUNNING" = "yes" ] && [ "$AIOT_STATE" = "running" ]; then
        STATE="valetudo mode — active and healthy"
    else
        STATE="valetudo mode — INCONSISTENT (see ISSUE lines above)"
    fi
elif [ "$GATE_STATE" = "PATCHED" ]; then
    STATE="installed, currently in cloud mode (previously activated)"
else
    STATE="installed, not yet activated"
fi
if [ "$ACTUAL_FIRMWARE" != "$EXPECTED_FIRMWARE" ]; then
    STATE="$STATE (FIRMWARE MISMATCH)"
fi

echo "Host      : $HOST"
echo "Firmware  : ${ACTUAL_FIRMWARE:-<unreadable>} (expected $EXPECTED_FIRMWARE)"
echo "Mode file : ${MODE:-<unknown>}"
echo "Valetudo  : $([ "$VALETUDO_RUNNING" = "yes" ] && echo running || echo "not running")"
if [ "$FRESH" != yes ] && [ "$MISSING_PUSH_COUNT" -gt 0 ]; then
    echo "Files     : $MISSING_PUSH_COUNT of $TOTAL_PUSH_COUNT pushed files not present on device — see 'Pushed files' above, consider re-running install.sh"
fi
echo "State     : $STATE"

# On a genuinely fresh/never-provisioned robot, every "not installed yet"
# line above is expected, not a problem — INSTALL_ISSUES stays out of the
# final count/exit code so a robot in exactly the state it should be in
# doesn't exit non-zero. Anywhere else (already installed, just missing a
# file or two), those same issues are real and get folded in.
if [ "$FRESH" != yes ]; then
    ISSUES=$((ISSUES + INSTALL_ISSUES))
fi

echo
if [ "$ISSUES" -gt 0 ]; then
    err "== $ISSUES item(s) need attention (see ISSUE lines above) =="
    exit 1
else
    ok "== All checked items look consistent =="
fi
