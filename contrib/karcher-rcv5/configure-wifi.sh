#!/bin/bash
#
# Reconnects the robot to WiFi after a WiFi/config reset (or any time you
# just want to switch networks) — see README.md "Recovering from a
# WiFi/config reset" for the three reset triggers this recovers from.
#
# Uses adb, not ssh. Every other script here talks to the robot over ssh
# via lib.sh's SSH_OPTS, but the whole reason this script exists is that a
# WiFi reset kills network connectivity — ssh isn't reachable. adb over the
# USB OTG port survives it (root shell, already established elsewhere in
# this project's own rooting work).
#
# The wpa_cli sequence is built as a local temp file and pushed to the
# device rather than interpolated into an `adb shell "..."` command string,
# specifically to avoid double-shell-quoting a WiFi password through two
# separate shells (this Mac's bash, then the robot's busybox ash) — a
# password containing '"', '$', a backtick, or a single quote would be a
# real risk to get wrong that way. Built once, safely, here instead.
#
# Also ensures /userdata/config/wifi.conf has the cloud-pairing fields
# (uid/key/http_host/mqtt_host/mqtt_port/district) aiot_client needs to
# even attempt a connection at all — filling in only whichever are
# missing, never touching real ones already there. Without this, a
# never-paired robot would end up connected to WiFi but with nowhere for
# aiot_client to connect to, meaning Valetudo would receive zero
# communication from it even after activation. See manage.sh's
# ensure_wifi_conf_cloud_fields() for the full reasoning (same logic,
# duplicated — this runs over adb shell, that runs natively on-device).
#
# Staged, then verified, then saved — never the other way around. The
# on-device sequence stages the network (add/set/enable/select) and prints
# an explicit "STAGED_OK" line, WITHOUT calling save_config. This Mac-side
# script only calls save_config once wpa_state=COMPLETED is actually
# confirmed; on failure it removes the staged (never-persisted) network
# instead. Two independent reasons for the "stage, don't trust the exit
# code" split:
#   - select_network live-disables every other configured network. If
#     save_config ran up front and the new network then failed, a typo'd
#     password would have already overwritten the last known-good config
#     on disk — recoverable only via adb, not even a reboot.
#   - this rootfs's adbd looks like a legacy build (no shell_v2 marker in
#     the binary), which may not reliably propagate the remote command's
#     exit code back to us — and wpa_cli itself can reply "FAIL" while
#     still exiting 0. So nothing here trusts an exit code for success;
#     every step is confirmed by grepping its actual text output instead.
#
# Runs on the Mac, drives the robot over adb. Usage: ./configure-wifi.sh [ssid]
# (password is always prompted, never accepted via argv/env — same rule
# tests/tools/probe_firmware_upgrade.py's getpass() prompt follows in the
# sibling repo)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

REMOTE_SCRIPT=/tmp/_configure-wifi.sh

# shquote STRING -> that string, safely single-quoted for embedding in a
# POSIX sh script generated on the Mac and run on the robot. Survives any
# character the input could contain, including embedded quotes.
shquote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

echo "== Pre-flight =="
command -v adb >/dev/null 2>&1 || { err "ERROR: adb not found on PATH"; exit 1; }

DEVICE_COUNT=$(adb devices | awk 'NR>1 && $2=="device" {c++} END {print c+0}')
if [ "$DEVICE_COUNT" -ne 1 ]; then
    err "ERROR: expected exactly one adb device in 'device' state, found $DEVICE_COUNT."
    err "Run 'adb devices' yourself and make sure only the robot is attached (and authorized)."
    exit 1
fi
ok "OK: exactly one adb device attached"

ROOT_UID="$(adb shell id -u 2>/dev/null | tr -d '\r\n')"
if [ "$ROOT_UID" != "0" ]; then
    err "ERROR: adb shell is not root (id -u = '${ROOT_UID:-<unreadable>}'). This toolkit assumes an already-rooted robot."
    exit 1
fi
ok "OK: adb shell is root"

if ! adb shell "pidof wpa_supplicant" >/dev/null 2>&1; then
    err "ERROR: wpa_supplicant is not running on the robot. Per README.md, S66_wifi should"
    err "always start it — if it's genuinely not running, this script can't help; something"
    err "else is wrong first."
    exit 1
fi
ok "OK: wpa_supplicant is running"

WIFI_SSID="${1:-}"
if [ -z "$WIFI_SSID" ]; then
    IFS= read -r -p "WiFi SSID: " WIFI_SSID
fi
[ -n "$WIFI_SSID" ] || { err "ERROR: SSID cannot be empty"; exit 1; }

IFS= read -r -s -p "WiFi password (not echoed): " WIFI_PASSWORD
echo
[ -n "$WIFI_PASSWORD" ] || { err "ERROR: password cannot be empty"; exit 1; }

SSID_ARG="$(shquote "\"$WIFI_SSID\"")"
PSK_ARG="$(shquote "\"$WIFI_PASSWORD\"")"

TMP_SCRIPT="$(mktemp)"
cleanup() {
    rm -f "$TMP_SCRIPT"
    adb shell "rm -f $REMOTE_SCRIPT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Stages the network only — never calls save_config itself. Cleans up
# after itself on its OWN failure (trap, not the Mac-side script) since by
# the time a later step fails, the only place that still knows the
# already-assigned network id is this remote shell's own variable.
cat > "$TMP_SCRIPT" <<EOF
#!/bin/sh
set -eu
NET_ID=""
cleanup_on_fail() {
    # if/then, not "test && cmd" — an if's condition is exempt from set -e,
    # a bare && chain used as a standalone statement is not guaranteed to
    # be across shells, and this runs as an EXIT trap under set -e.
    if [ -n "\$NET_ID" ]; then
        wpa_cli -i wlan0 remove_network "\$NET_ID" >/dev/null 2>&1 || true
    fi
}
trap cleanup_on_fail EXIT

# run WPA_CLI_ARGS... — wpa_cli can reply "FAIL" while still exiting 0, so
# every call here is checked by its actual text reply, never by \$?.
run() {
    out="\$(wpa_cli -i wlan0 "\$@" 2>&1)"
    case "\$out" in
        *FAIL*) echo "WPA_CLI_FAIL: \$* -> \$out" >&2; exit 1 ;;
    esac
    printf '%s' "\$out"
}

NET_ID="\$(run add_network)"
run set_network "\$NET_ID" ssid $SSID_ARG >/dev/null
run set_network "\$NET_ID" psk $PSK_ARG >/dev/null
run enable_network "\$NET_ID" >/dev/null
run select_network "\$NET_ID" >/dev/null

trap - EXIT
echo "STAGED_OK net_id=\$NET_ID"
EOF

echo "== Staging the network on the robot (not yet saved to disk) =="
adb push "$TMP_SCRIPT" "$REMOTE_SCRIPT" >/dev/null
STAGE_OUTPUT="$(adb shell "sh $REMOTE_SCRIPT" 2>&1)" || true
echo "$STAGE_OUTPUT" | sed 's/^/  /'

NET_ID="$(printf '%s\n' "$STAGE_OUTPUT" | sed -n 's/^STAGED_OK net_id=//p' | head -1)"
if [ -z "$NET_ID" ]; then
    err "ERROR: staging failed — no STAGED_OK confirmation in the output above."
    err "Nothing has been saved to disk; the robot's existing WiFi config is untouched."
    exit 1
fi
ok "OK: network staged (id $NET_ID) — not yet saved to disk"

echo "== Verifying (polling, not a blind sleep) =="
CONNECTED=no
for _ in $(seq 1 8); do
    if adb shell "wpa_cli -i wlan0 status" 2>/dev/null | grep -q "^wpa_state=COMPLETED"; then
        CONNECTED=yes
        break
    fi
    sleep 2
done

if [ "$CONNECTED" != yes ]; then
    err "ERROR: wpa_state never reached COMPLETED after ~15s. Removing the staged (unsaved)"
    err "network so the robot's previous config is untouched on the next reboot:"
    adb shell "wpa_cli -i wlan0 remove_network $NET_ID" >/dev/null 2>&1 || true
    err "  adb shell wpa_cli -i wlan0 status   # to see what actually happened"
    exit 1
fi
ok "OK: wpa_state=COMPLETED"

SAVE_OUTPUT="$(adb shell "wpa_cli -i wlan0 save_config" 2>&1)" || true
case "$SAVE_OUTPUT" in
    *OK*)
        ok "OK: configuration saved to disk"
        ;;
    *)
        err "ERROR: save_config did not reply OK (got: $SAVE_OUTPUT)."
        err "The robot is connected right now but this may not survive a reboot. Retry by hand:"
        err "  adb shell wpa_cli -i wlan0 save_config"
        exit 1
        ;;
esac

echo "== Updating wifi.conf's network fields to match =="
# Keeps wifi.conf's ssid/psk in sync with what was just actually connected -- see
# manage.sh's update_wifi_conf_network() for the full reasoning (duplicated here, same
# as every other piece of logic shared between the Mac-side and on-device tools in this
# project). $SSID_ARG/$PSK_ARG are already shquote()'d with embedded literal double
# quotes (built above for the wpa_cli staging step), so splicing them in unquoted here
# reuses that same escaping rather than needing a second scheme.
cat > "$TMP_SCRIPT" <<EOF
#!/bin/sh
set -eu
WIFI_CONF="/userdata/config/wifi.conf"
mkdir -p "\$(dirname "\$WIFI_CONF")" 2>/dev/null || true
[ -f "\$WIFI_CONF" ] || touch "\$WIFI_CONF"
grep -v '^ssid=' "\$WIFI_CONF" | grep -v '^psk=' > "\$WIFI_CONF.tmp" || true
echo ssid=$SSID_ARG >> "\$WIFI_CONF.tmp"
echo psk=$PSK_ARG >> "\$WIFI_CONF.tmp"
mv "\$WIFI_CONF.tmp" "\$WIFI_CONF"
EOF
adb push "$TMP_SCRIPT" "$REMOTE_SCRIPT" >/dev/null
adb shell "sh $REMOTE_SCRIPT" >/dev/null 2>&1 || warn "WARNING: could not update wifi.conf's ssid/psk — check by hand: adb shell cat /userdata/config/wifi.conf"

echo "== Ensuring wifi.conf has the cloud-pairing fields Valetudo needs =="
# Fills in any MISSING cloud-pairing fields in wifi.conf on the robot,
# never touching ones that already exist -- see manage.sh's do_wifi()
# ensure_wifi_conf_cloud_fields() for the full reasoning (duplicated here,
# same as every other piece of logic shared between the Mac-side and
# on-device tools in this project, since a Mac-side bash script can't
# literally share code with a robot-side sh one). Run as a single adb
# shell command rather than pushing a separate script file, since it's a
# one-shot handful of lines.
adb shell '
WIFI_CONF="/userdata/config/wifi.conf"
mkdir -p "$(dirname "$WIFI_CONF")" 2>/dev/null || true
[ -f "$WIFI_CONF" ] || touch "$WIFI_CONF"
grep -q "^uid=" "$WIFI_CONF" || echo "uid=unpaired-$$-$(date +%s)" >> "$WIFI_CONF"
grep -q "^key=" "$WIFI_CONF" || echo "key=k$(date +%s)-$$" >> "$WIFI_CONF"
grep -q "^http_host=" "$WIFI_CONF" || echo "http_host=eu-cdndevaiot.3irobotix.net" >> "$WIFI_CONF"
grep -q "^mqtt_host=" "$WIFI_CONF" || echo "mqtt_host=eu-gamqttaiot.3irobotix.net" >> "$WIFI_CONF"
grep -q "^mqtt_port=" "$WIFI_CONF" || echo "mqtt_port=8883" >> "$WIFI_CONF"
grep -q "^district=" "$WIFI_CONF" || echo "district=DEU" >> "$WIFI_CONF"
' >/dev/null 2>&1 || warn "WARNING: could not ensure wifi.conf cloud fields — check by hand: adb shell cat /userdata/config/wifi.conf"

ROBOT_IP="$(adb shell "ifconfig wlan0" 2>/dev/null | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p' | head -1 | tr -d '\r')"
if [ -z "$ROBOT_IP" ]; then
    warn "WARNING: connected, but couldn't parse an IP from 'ifconfig wlan0'. Check by hand:"
    warn "  adb shell ifconfig wlan0"
else
    ok "configure-wifi.sh complete. Robot is on the network at: $ROBOT_IP"
    ok "Next: ssh root@$ROBOT_IP, or ./diagnose.sh $ROBOT_IP"
fi
warn "NOTE: a separate vendor process (wifiManager) also manages this same config file"
warn "under conditions we haven't fully mapped. If this connection doesn't survive a"
warn "later reboot (e.g. the one activate.sh's first run triggers), re-check with:"
warn "  adb shell wpa_cli -i wlan0 status"
