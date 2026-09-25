#!/bin/sh
# manage.sh — on-device entry point for someone with only SSH access to the
# robot (no laptop, no checkout of this repo, no README.md). Deploy to
# /userdata/valetudo/manage.sh.
#
# Every multi-step sequence here (activate/uninstall) is a direct mirror of
# what activate.sh/uninstall.sh do from the Mac — those scripts contain no
# Mac-only logic, they just call karcher-cloud-switch.sh/aiot-gate.sh/
# S96valetudo over ssh in order. This wraps the same calls locally, plus a
# contextual "what can I do right now" menu so the workflow knowledge that
# would otherwise only live in README.md is discoverable on-device.
#
# Usage: manage.sh {status|activate|deactivate|wifi [ssid]|uninstall [--purge]|help}
#        (no args, or an unrecognized one, behaves like `help`)
#
# `wifi` closes a specific gap: configure-wifi.sh (the Mac-side, adb-based
# WiFi recovery tool — see README.md "Recovering from a WiFi/config reset")
# isn't itself copied to the robot on install, so someone connected only via
# `adb shell` (no laptop checkout, the exact situation a WiFi reset causes)
# had no on-device equivalent. This is that equivalent — same stage/verify/
# save design (never trusts wpa_cli's exit code, only its text reply; never
# calls save_config until wpa_state=COMPLETED is actually confirmed; removes
# the staged network if it never connects, so a reboot falls back to the
# last-known-good config — but NOT if it connects and only save_config then
# fails, since at that point removing it would sever a live connection),
# adapted to run locally instead of over adb push/shell. It works
# identically over ssh or `adb shell` — manage.sh has no transport of its
# own, it's just a file on disk.
#
# Also ensures /userdata/config/wifi.conf has the cloud-pairing fields
# aiot_client needs to attempt a connection at all (see
# ensure_wifi_conf_cloud_fields() below) — this and configure-wifi.sh are
# meant to be fully equivalent, interchangeable ways to configure WiFi
# (external, over adb, vs. on-device), neither requiring the other.

set -eu

REMOTE_DIR="/userdata/valetudo"
CCS="$REMOTE_DIR/karcher-cloud-switch.sh"
AG="$REMOTE_DIR/aiot-gate.sh"
S96="$REMOTE_DIR/S96valetudo"
# Matches upgrade-firmware.sh's REMOTE_STAGE_DIR in lib.sh — can't literally
# share it (that's a Mac-side bash constant, this is a robot-side sh
# script), so if that path ever changes, change it here too.
REMOTE_STAGE_DIR="/userdata/valetudo-firmware-upgrade"

# field_of TEXT LABEL — same idiom as diagnose.sh's helper of the same
# name (tested there against real status output this session): pulls the
# value after "LABEL : " out of karcher-cloud-switch.sh's/aiot-gate.sh's
# own status text. Used here against LOCALLY captured output (no ssh, we
# already are the robot) rather than relayed text, but the parsing itself
# is identical on purpose — one proven technique, two call sites.
field_of() {
    printf '%s\n' "$1" | sed -n "s|^$2[[:space:]]*:[[:space:]]*||p" | head -1
}

# --- status / contextual menu -----------------------------------------

print_status_and_menu() {
    CCS_STATUS="$("$CCS" status 2>&1 || true)"
    AG_STATUS="$("$AG" status 2>&1 || true)"

    echo "== karcher-cloud-switch.sh status =="
    echo "$CCS_STATUS" | sed 's/^/  /'
    echo
    echo "== aiot-gate.sh status =="
    echo "$AG_STATUS" | sed 's/^/  /'
    echo
    if pidof valetudo >/dev/null 2>&1; then
        VALETUDO_RUNNING=yes
    else
        VALETUDO_RUNNING=no
    fi
    echo "== valetudo process : $([ "$VALETUDO_RUNNING" = yes ] && echo running || echo "not running") =="

    MODE="$(field_of "$CCS_STATUS" "mode file")"
    HOSTS_SOURCE="$(field_of "$CCS_STATUS" "/etc/hosts source")"
    GATE_STATE="$(field_of "$AG_STATUS" "live /oem gate")"
    AIOT_STATE="$(field_of "$AG_STATUS" "aiot_client.bin")"

    echo
    echo "== What you can do =="
    if [ "$MODE" = "valetudo" ] \
       && [ "$HOSTS_SOURCE" = "valetudo" ] \
       && [ "$GATE_STATE" = "PATCHED" ] \
       && [ "$VALETUDO_RUNNING" = yes ] \
       && [ "$AIOT_STATE" = running ]; then
        echo "Currently: valetudo mode, active and healthy."
        echo "  manage.sh deactivate   — switch back to the real Kärcher cloud"
    elif [ "$MODE" = "valetudo" ]; then
        echo "Currently: mode file says valetudo, but something doesn't match (see status"
        echo "above — compare mode file / hosts source / gate / process). This robot won't"
        echo "necessarily behave as expected."
        echo "  manage.sh activate     — re-run activation, may fix it"
        echo "  manage.sh deactivate   — switch back to the real Kärcher cloud instead"
    elif [ "$GATE_STATE" = "PATCHED" ]; then
        echo "Currently: installed, in cloud mode, previously activated at least once."
        echo "  manage.sh activate     — switch into valetudo mode"
    else
        echo "Currently: installed, not yet activated."
        echo "  manage.sh activate     — set up and switch into valetudo mode"
    fi
    echo
    echo "Always available: manage.sh status, manage.sh wifi [ssid], manage.sh uninstall [--purge]"
}

# --- activate -----------------------------------------------------------

do_activate() {
    if mountpoint -q /oem 2>/dev/null; then
        echo "== /oem overlay already active =="
    else
        echo "== Arming /oem overlay =="
        "$AG" overlay on
    fi

    if mountpoint -q /oem 2>/dev/null; then
        echo "== Patching wifi-deamon.sh (idempotent) =="
        "$AG" patch
        echo "== Starting Valetudo =="
        "$S96" start
        sleep 2
        echo "== Switching to valetudo mode =="
        "$CCS" valetudo
        echo
        echo "Done. Verify at http://<this robot's IP>. Undo with: manage.sh deactivate"
    else
        echo
        echo "The /oem overlay is staged but not yet active — this robot needs a reboot"
        echo "before it can be patched (same as activate.sh's own first-run behavior)."
        echo "This script will NOT reboot the robot for you. Do exactly this, nothing else:"
        echo "  1. run 'reboot'"
        echo "  2. wait for the robot to come back"
        echo "  3. run 'manage.sh activate' again — it will finish the job from here"
        echo "(don't run 'aiot-gate.sh patch' yourself in between — it would patch the file"
        echo "but never switch the robot into valetudo mode, leaving it half-done)"
    fi
}

# --- deactivate -----------------------------------------------------------

do_deactivate() {
    "$CCS" cloud
}

# --- wifi -------------------------------------------------------------

WIFI_CONF="/userdata/config/wifi.conf"

# Fills in any MISSING cloud-pairing fields in wifi.conf, never touching
# ones that already exist -- so a robot that's already been paired (via the
# app, or via provision-wifi.py) keeps whatever real values it has, while a
# never-paired robot gets safe placeholders instead of being left with no
# working config at all (without SOME http_host/mqtt_host, aiot_client has
# nowhere to connect to, which means it never even attempts the connection
# that karcher-cloud-switch.sh's redirect is designed to intercept --
# Valetudo would receive zero communication from it, not just be
# "unprotected"). uid is which cloud ACCOUNT ends up owning the robot
# (confirmed in the app's own WifiDataBean constructor), so its placeholder
# is random and deliberately NOT shaped like a real 19-digit numeric
# Kärcher account id -- same reasoning as provision-wifi.py's
# generate_placeholder_uid(), duplicated here since this is sh, not
# Python. http_host/mqtt_host use the same real EU defaults
# provision-wifi.py does, NOT a fake/invalid hostname -- an unresolvable
# placeholder would permanently break `karcher-cloud-switch.sh cloud`
# (aiot_client could never resolve it again even with the redirect
# removed), which is strictly worse than the narrow, low-consequence
# window this is meant to close.
ensure_wifi_conf_cloud_fields() {
    mkdir -p "$(dirname "$WIFI_CONF")" 2>/dev/null || true
    [ -f "$WIFI_CONF" ] || touch "$WIFI_CONF"
    grep -q '^uid=' "$WIFI_CONF" || echo "uid=unpaired-$$-$(date +%s)" >> "$WIFI_CONF"
    grep -q '^key=' "$WIFI_CONF" || echo "key=k$(date +%s)-$$" >> "$WIFI_CONF"
    grep -q '^http_host=' "$WIFI_CONF" || echo "http_host=eu-cdndevaiot.3irobotix.net" >> "$WIFI_CONF"
    grep -q '^mqtt_host=' "$WIFI_CONF" || echo "mqtt_host=eu-gamqttaiot.3irobotix.net" >> "$WIFI_CONF"
    grep -q '^mqtt_port=' "$WIFI_CONF" || echo "mqtt_port=8883" >> "$WIFI_CONF"
    grep -q '^district=' "$WIFI_CONF" || echo "district=DEU" >> "$WIFI_CONF"
}

# Mirrors configure-wifi.sh's stage/verify/save design (see that script's
# own header comment for the full reasoning) minus the adb push/shell
# wrapper — this runs directly on the robot, so there's no second shell
# boundary to cross and no need for its shquote() escaping: $ssid/$password
# are used here as plain shell variables, not spliced as literal text into
# a separately-interpreted generated script, so normal "$var" quoting is
# already exactly correct regardless of what characters they contain.
#
# POSIX `read` has no `-s`/`-p` (bash-only; confirmed by direct test against
# dash: `read -s` errors "Illegal option -s") — stty -echo/echo stands in
# for -s, plain printf stands in for -p.
do_wifi() {
    if ! pidof wpa_supplicant >/dev/null 2>&1; then
        echo "ERROR: wpa_supplicant is not running — something else is wrong first." >&2
        exit 1
    fi

    ssid="${1:-}"
    if [ -z "$ssid" ]; then
        printf 'WiFi SSID: '
        IFS= read -r ssid
    fi
    [ -n "$ssid" ] || { echo "ERROR: SSID cannot be empty" >&2; exit 1; }

    NET_ID=""
    STTY_OFF=no
    wifi_cleanup() {
        # Covers the whole staged window, not just the password prompt:
        # armed before the password is read, only disarmed after
        # save_config actually confirms OK. Any failure in between —
        # read, staging, verify, save — leaves the robot's prior config
        # untouched on the next reboot.
        if [ "$STTY_OFF" = yes ]; then
            stty echo 2>/dev/null || true
        fi
        if [ -n "$NET_ID" ]; then
            wpa_cli -i wlan0 remove_network "$NET_ID" >/dev/null 2>&1 || true
        fi
    }
    trap wifi_cleanup EXIT

    printf 'WiFi password (not echoed): '
    stty -echo 2>/dev/null || true
    STTY_OFF=yes
    IFS= read -r password
    stty echo 2>/dev/null || true
    STTY_OFF=no
    echo
    [ -n "$password" ] || { echo "ERROR: password cannot be empty" >&2; exit 1; }

    # wpa_cli can reply "FAIL" while still exiting 0 — every call here is
    # checked by its actual text reply, never by $?.
    run_wpa() {
        out="$(wpa_cli -i wlan0 "$@" 2>&1)"
        case "$out" in
            *FAIL*) echo "ERROR: wpa_cli $* -> $out" >&2; exit 1 ;;
        esac
        printf '%s' "$out"
    }

    echo "== Staging network (not yet saved to disk) =="
    NET_ID="$(run_wpa add_network)"
    run_wpa set_network "$NET_ID" ssid "\"$ssid\"" >/dev/null
    run_wpa set_network "$NET_ID" psk "\"$password\"" >/dev/null
    run_wpa enable_network "$NET_ID" >/dev/null
    run_wpa select_network "$NET_ID" >/dev/null
    echo "OK: network staged (id $NET_ID) — not yet saved to disk"

    echo "== Verifying (polling, not a blind sleep) =="
    connected=no
    i=0
    while [ "$i" -lt 8 ]; do
        if wpa_cli -i wlan0 status 2>/dev/null | grep -q "^wpa_state=COMPLETED"; then
            connected=yes
            break
        fi
        sleep 2
        i=$((i + 1))
    done

    if [ "$connected" != yes ]; then
        echo "ERROR: wpa_state never reached COMPLETED after ~15s." >&2
        echo "Removing the staged (unsaved) network — the robot's previous config is" >&2
        echo "untouched. To see what actually happened: wpa_cli -i wlan0 status" >&2
        exit 1
    fi
    echo "OK: wpa_state=COMPLETED"

    SAVE_OUTPUT="$(wpa_cli -i wlan0 save_config 2>&1)"
    case "$SAVE_OUTPUT" in
        *OK*)
            echo "OK: configuration saved to disk"
            NET_ID=""
            trap - EXIT
            ;;
        *)
            # Clear NET_ID (not the whole trap) before exiting: the network
            # is live and selected right now (wpa_state=COMPLETED above),
            # just not persisted — removing it here would sever the very
            # connection this error says is still up.
            NET_ID=""
            echo "ERROR: save_config did not reply OK (got: $SAVE_OUTPUT)." >&2
            echo "Connected right now but this may not survive a reboot. Retry by hand:" >&2
            echo "  wpa_cli -i wlan0 save_config" >&2
            exit 1
            ;;
    esac

    echo "== Ensuring wifi.conf has the cloud-pairing fields Valetudo needs =="
    ensure_wifi_conf_cloud_fields

    ROBOT_IP="$(ifconfig wlan0 2>/dev/null | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p' | head -1)"
    if [ -n "$ROBOT_IP" ]; then
        echo "manage.sh wifi complete. Robot is on the network at: $ROBOT_IP"
    else
        echo "Connected, but could not parse an IP from 'ifconfig wlan0'. Check by hand:"
        echo "  ifconfig wlan0"
    fi
    echo "NOTE: a separate vendor process (wifiManager) also manages this same config file"
    echo "under conditions we haven't fully mapped. If this doesn't survive a later reboot,"
    echo "re-check with: wpa_cli -i wlan0 status"
}

# --- uninstall ------------------------------------------------------------

do_uninstall() {
    case "${1:-}" in
        "") purge=no ;;
        --purge) purge=yes ;;
        *)
            echo "ERROR: unknown option '$1' (did you mean --purge?)" >&2
            echo "usage: manage.sh uninstall [--purge]" >&2
            exit 1
            ;;
    esac

    # Stop here on failure, same as uninstall.sh — continuing (especially
    # into --purge) with the robot in an unknown cert/hosts state would
    # remove the recovery tools along with everything else.
    echo "== Switching back to stock cloud mode =="
    if ! "$CCS" cloud; then
        echo "ERROR: switch to cloud failed — check '$CCS status' by hand." >&2
        echo "Not continuing: purging now could leave this robot unrecoverable." >&2
        exit 1
    fi

    echo "== Reverting the wifi-deamon.sh aiot_client gate (if patched) =="
    if [ -x "$AG" ] && grep -q "valetudo-gate BEGIN" /oem/bin/wifi-deamon.sh 2>/dev/null; then
        "$AG" unpatch || echo "WARNING: could not revert the gate — check '$AG status' by hand" >&2
    fi

    echo "== Stopping Valetudo =="
    "$S96" stop || true

    echo "== Removing boot-autostart hook =="
    rm -f /userdata/cfg/rockchip_test/auto_reboot.sh

    if [ "$purge" = yes ]; then
        echo "== Disarming the /oem overlay =="
        # Otherwise it stays bind-mounted indefinitely and could mask a
        # future vendor OTA under it — --purge is supposed to mean "clean
        # slate", so leaving this armed would contradict that.
        if [ -x "$AG" ]; then
            "$AG" overlay off || echo "WARNING: could not disarm the overlay — check '$AG status' by hand" >&2
        fi

        echo "== Removing any staged firmware upgrade image =="
        rm -rf "$REMOTE_STAGE_DIR"

        echo "== Purging /userdata/valetudo and the derived hosts variant =="
        echo "(this deletes manage.sh itself — that's fine, it's already running)"
        rm -f /userdata/etc-hosts.valetudo
        rm -rf "$REMOTE_DIR"
        echo "purged (the three .orig backups under /userdata were NOT touched)"
    else
        echo "skipping purge (pass --purge to also remove $REMOTE_DIR)"
    fi
}

# --- dispatch ---------------------------------------------------------

case "${1:-help}" in
    status) print_status_and_menu ;;
    activate) do_activate ;;
    deactivate) do_deactivate ;;
    wifi) shift; do_wifi "${1:-}" ;;
    uninstall) shift; do_uninstall "${1:-}" ;;
    help|*) print_status_and_menu ;;
esac
