#!/bin/sh
#
# Real boot-time logic, invoked (not sourced) by auto_reboot.sh — see that
# file's own header for why the split exists. Only acts when the last
# explicit `karcher-cloud-switch.sh` call chose valetudo mode; anything else
# (mode file absent, empty, or corrupted) leaves the robot fully stock.
#
# Deploy to /userdata/valetudo/boot-hook.sh.
#

set -u

MODE_FILE=/userdata/valetudo/mode
LOG=/tmp/valetudo-boot-hook.log
# KaercherAiotDummycloud.BIND_IP and its HTTP_PORT/MQTT_PORT. Deliberately NOT
# anchored on trailing whitespace: this busybox has CONFIG_FEATURE_NETSTAT_WIDE
# unset, so the address column's exact padding/truncation isn't something we've
# verified on-device. Nothing else on this robot binds 127.0.13.38, so the bare
# address:port is specific enough.
DUMMYCLOUD_HTTP='127\.0\.13\.38:443'
DUMMYCLOUD_MQTT='127\.0\.13\.38:8883'
WAIT_MAX=60

MODE="cloud"
[ -r "$MODE_FILE" ] && MODE="$(cat "$MODE_FILE" 2>/dev/null)"

[ "$MODE" = "valetudo" ] || exit 0

# /tmp, not /userdata: no flash wear, and /tmp is already guaranteed to exist
# (tmpfs, mounted before this ever runs). Truncated per boot regardless, so it's
# always just this boot's record. Trade-off: unlike the vendor's own persistent
# /userdata/log files, this does NOT survive the reboot it's diagnosing — read it
# live (or before power-cycling again) if a boot goes wrong. Console output from
# an S99-backgrounded script is otherwise unrecoverable after the fact either way.
exec > "$LOG" 2>&1

# "Valetudo is ready" means exactly "both dummycloud listeners are bound", since
# those two sockets are what the switch below redirects aiot_client at.
# S96valetudo starts it with start-stop-daemon -S -b, which only proves the fork
# happened — never that Node finished initializing. This was a flat `sleep 5`: an
# unverified guess, simultaneously too long on a fast boot and too short on a slow
# one. busybox here has no nc (CONFIG_NC is not set in the firmware's
# busybox.config, and no separate netcat binary ships), so netstat is the listen
# check. Note this only removes OUR delay — the real exposure window is S90's
# wifi-deamon.sh reaching its ~6s aiot_client launch before S99 runs us at all,
# which is aiot-gate.sh's job, not this poll's.
dummycloud_listening() {
    netstat -ltn 2>/dev/null | grep -q "$DUMMYCLOUD_HTTP" || return 1
    netstat -ltn 2>/dev/null | grep -q "$DUMMYCLOUD_MQTT"
}

[ -x /userdata/valetudo/S96valetudo ] && /userdata/valetudo/S96valetudo start

elapsed=0
while [ "$elapsed" -lt "$WAIT_MAX" ]; do
    if dummycloud_listening; then
        echo "boot-hook: dummycloud listening after ${elapsed}s"
        break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

# Fallback, not a failure: switching anyway beats leaving the robot pointed at the
# real cloud because Valetudo happened to be slow. aiot-gate.sh's own deadline is
# the backstop if even this doesn't produce a working redirect.
[ "$elapsed" -ge "$WAIT_MAX" ] && \
    echo "boot-hook: WARNING dummycloud NOT listening after ${WAIT_MAX}s — applying the redirect anyway"

[ -x /userdata/valetudo/karcher-cloud-switch.sh ] && /userdata/valetudo/karcher-cloud-switch.sh valetudo
