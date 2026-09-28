#!/bin/sh
# aiot-gate.sh — close the boot-time window in which aiot_client.bin can still reach
# the real 3irobotix cloud. Runs ON the robot (busybox ash). Deploy to
# /userdata/valetudo/aiot-gate.sh.
#
# THE RACE THIS EXISTS FOR
#
# /etc/init.d/S90robotWifiManager backgrounds /oem/bin/wifi-deamon.sh, whose watchdog
# loop (`sleep 1` per iteration) starts calling checkwifiManager() once LoopCount > 5 —
# ~6s after S90 — and every second thereafter. checkwifiManager() does
# `pidof aiot_client.bin` and launches /oem/bin/aiot_client.bin if none is running.
# That is the ONLY spawn site in the whole firmware (grepped every init.d script and
# all of /oem).
#
# Our own boot hook is /etc/init.d/S99_auto_reboot -> auto_reboot.sh -> boot-hook.sh,
# which is strictly later, and S90..S98 can easily take longer than those 6s. So no
# amount of reacting faster at S99 helps: making boot-hook.sh's wait smarter (it is,
# now) removes OUR self-imposed delay but does nothing about the S90->S99 gap. The
# launch site itself has to be gated, which is what this script does.
#
# WHAT IT DOES
#
# Patches a guard into wifi-deamon.sh's main loop so checkwifiManager() is skipped
# while /userdata/valetudo/mode says "valetudo" and /tmp/valetudo_cloud_ready is
# absent. karcher-cloud-switch.sh touches that flag inside restart_aiot_client(),
# i.e. only after the /etc/hosts redirect and cert swap are applied AND verified.
# Result: in valetudo mode aiot_client.bin does not start at all until it can only
# reach the local dummycloud.
#
# The guard carries its own 300s uptime deadline. A boot where boot-hook.sh never
# completes (missing trampoline after a GPIO reset is the known cause - see
# project memory - but this fires the same way for any cause) actively reverts
# to cloud mode via karcher-cloud-switch.sh, then opens the gate either way.
# This is a deliberate choice, not just a safety net: a reset's whole point is
# "go back to a known state", and self-healing back into valetudo mode here
# would fight that intent instead of respecting it - so the fallback is a
# clean stock revert, never a silent retry at being Valetudo. persist_mode
# inside that revert updates the mode file too, so later boots stay consistent
# rather than repeating the same failed attempt forever. Detect it with:
#   grep valetudo-gate /userdata/log/miio_deamon.log
# That one line stays in the vendor's own persistent /userdata/log (unlike our
# own logging, which lives in /tmp to avoid flash wear — see boot-hook.sh):
# it exists specifically to survive the very reboot this deadline causes, so
# writing it to tmpfs would defeat the point. It's a single line on a rare
# fallback path, not a source of meaningful wear.
# A hit there means boot-hook.sh didn't finish in time on that boot; check
# /tmp/valetudo-boot-hook.log for why (only if read before the next reboot —
# it's gone after that, same as everything else under /tmp).
#
# /oem WRITABILITY — LIVE-CONFIRMED 2026-09-19, do not re-litigate this
#
# /oem has no independent writable partition. It is either the stock read-only
# rootfs (any write fails with "Read-only file system"), or bind-mounted from
# /userdata/debug_dir/oem whenever /userdata/sys_debug_mode exists (the
# S88scinit debug-mode hook, which runs BEFORE S90). There is no third state.
# `mount | grep -w /oem` showing `/dev/ubi8_0` is a red herring — that is
# /userdata's OWN backing device, not a separate /oem partition; a bind mount
# of a file/dir living on /userdata naturally reports /userdata's underlying
# device. Misreading that line as "native writable /oem" once led to running
# `overlay off`, which correctly reverted /oem to stock (cert mismatch, patch
# gone) because the flag was the only thing making it writable. Nothing was
# lost — /userdata/debug_dir/oem was untouched throughout — but the overlay
# is THE mechanism here, not a fallback for if /oem "turns out" read-only.
# `overlay on`/`patch` need a reboot in between the first time; after that,
# `mode_status`'s "/oem source" line tells you which state you're in.
#
# REVERSIBILITY
#   unpatch      restores the byte-exact backup taken at patch time
#   overlay off  drops the flag; next boot uses the stock read-only /oem again
#                (this undoes the gate AND the cert swap — not a casual toggle)
# The real /oem partition is never written by the overlay path at all.

set -eu

MODE_FILE=/userdata/valetudo/mode
READY_FLAG=/tmp/valetudo_cloud_ready
OEM_TARGET=/oem/bin/wifi-deamon.sh
OVERLAY_DIR=/userdata/debug_dir/oem
OVERLAY_FLAG=/userdata/sys_debug_mode
BACKUP=/userdata/wifi-deamon.sh.orig
MARKER="# valetudo-gate BEGIN"

# Exact anchors from I3.12.90's wifi-deamon.sh, each verified unique there:
# the function definition line, the tab-tab-indented call inside the watchdog
# loop, and `LoopCount=0` (the last statement before `while true`, so a function
# inserted after it is defined before the loop that calls it). Any mismatch means
# a different firmware build and patching is refused rather than guessed at.
ANCHOR_DEF='checkwifiManager()'
ANCHOR_CALL='		checkwifiManager'
ANCHOR_LOOP='LoopCount=0'

# Writes the guard function to $1. Kept out of the awk program so the inserted
# text is readable as shell rather than as awk string literals.
write_guard() {
    cat > "$1" <<'GUARD'

# valetudo-gate BEGIN - inserted by /userdata/valetudo/aiot-gate.sh
# Returns 0 (let checkwifiManager run) unless we are in valetudo mode and the
# local dummycloud redirect has not been applied and verified yet.
# ASCII only: this text is injected into a vendor script under an unknown locale.
valetudo_gate_open()
{
	[ -f /tmp/valetudo_cloud_ready ] && return 0
	[ "$(cat /userdata/valetudo/mode 2>/dev/null)" = "valetudo" ] || return 0

	# Deadline: never hold the robot cloudless forever. The touch makes this
	# log once - every later call short-circuits on the flag above.
	valetudo_gate_up=$(cut -d. -f1 /proc/uptime 2>/dev/null)
	case "$valetudo_gate_up" in
		''|*[!0-9]*) return 0 ;;
	esac
	[ "$valetudo_gate_up" -lt 300 ] && return 1

	# boot-hook.sh never finished the switch in time (a GPIO reset clearing
	# the trampoline at /data/cfg/rockchip_test/ is the known cause, but this
	# fires the same way for any cause). Revert to a known-good state - real
	# cloud - rather than opening onto whatever mismatched hosts/certs happen
	# to be sitting there: a reset (or its aftermath) means "go back to
	# stock", not "keep trying to be Valetudo". require_oem_writable() inside
	# this call can itself fail safely (e.g. the same reset also cleared the
	# /oem overlay) - in that case /oem is already stock, so there is nothing
	# to revert anyway; the unconditional touch below still opens the gate.
	# Re-stage the trampoline too, so a future boot gets a real chance to
	# switch back on its own terms instead of repeating this every time.
	echo "$(date '+%Y-%m-%d %H:%M:%S') :valetudo-gate deadline, reverting to cloud" >> /userdata/log/miio_deamon.log
	cp /userdata/valetudo/auto_reboot.sh /data/cfg/rockchip_test/auto_reboot.sh 2>/dev/null
	/userdata/valetudo/karcher-cloud-switch.sh cloud >>/tmp/valetudo-boot-hook.log 2>&1
	touch /tmp/valetudo_cloud_ready
	return 0
}
# valetudo-gate END
GUARD
}

# Probes $1 for writability with a throwaway file rather than touching the vendor
# script itself, so a read-only /oem is diagnosed without ever altering an mtime
# we'd then have to explain.
dir_writable() {
    probe="$1/.valetudo-rwtest.$$"
    touch "$probe" 2>/dev/null || return 1
    rm -f "$probe"
}

# Echoes the wifi-deamon.sh this run should patch, or exits 1 with a diagnosis.
# Prefers a live-writable /oem; falls back to a staged-but-not-yet-mounted
# overlay copy so `overlay on` + `patch` works in one session, before the reboot.
resolve_target() {
    if [ -f "$OEM_TARGET" ] && dir_writable /oem/bin; then
        echo "$OEM_TARGET"
        return 0
    fi
    if [ -f "$OVERLAY_DIR/bin/wifi-deamon.sh" ] && dir_writable "$OVERLAY_DIR/bin"; then
        echo "$OVERLAY_DIR/bin/wifi-deamon.sh"
        return 0
    fi
    echo "ERROR: /oem is read-only and no writable overlay copy exists." >&2
    echo "Run '$0 overlay on' (needs ~109MB of /userdata), reboot, then re-run '$0 patch'." >&2
    return 1
}

check_anchors() {
    target="$1"
    for spec in "$ANCHOR_DEF" "$ANCHOR_CALL" "$ANCHOR_LOOP"; do
        count=$(grep -c -x -F -e "$spec" "$target" || true)
        if [ "$count" != "1" ]; then
            echo "ERROR: expected exactly one '$spec' in $target, found $count." >&2
            echo "This is not the I3.12.90 wifi-deamon.sh this patch was written against — refusing." >&2
            return 1
        fi
    done
}

mode_status() {
    echo "mode file          : $(cat "$MODE_FILE" 2>/dev/null || echo '(absent -> cloud)')"
    # mountpoint -q, not dir_writable()'s touch-probe: this codebase's own
    # established model is that /oem has no third state (stock read-only
    # vs. the overlay bind-mount, nothing else — see the comment a few
    # lines down), so "is the overlay mounted" and "is /oem writable" are
    # the same fact. Reusing the read-only check the very next line already
    # does keeps mode_status() genuinely zero-write end to end; the actual
    # touch-probe stays in resolve_target(), which is deciding where to
    # write, not just reporting.
    if mountpoint -q /oem 2>/dev/null; then
        echo "/oem               : WRITABLE"
    else
        echo "/oem               : read-only (patch needs 'overlay on' + reboot)"
    fi
    # /oem has no writable partition of its own — WRITABLE above only ever means
    # the overlay is currently bind-mounted. Spelled out explicitly so this is
    # never mistaken for a native property of /oem again (see the 2026-09-19 note
    # at the top of this file).
    if mountpoint -q /oem 2>/dev/null; then
        echo "/oem source        : overlay ($OVERLAY_DIR bind-mounted over /oem)"
    else
        echo "/oem source        : stock read-only rootfs (no overlay active)"
    fi
    echo "overlay flag       : $([ -f "$OVERLAY_FLAG" ] && echo present || echo absent)"
    echo "overlay copy       : $([ -d "$OVERLAY_DIR" ] && echo present || echo absent)"
    if [ -f "$OEM_TARGET" ] && grep -q -F -e "$MARKER" "$OEM_TARGET" 2>/dev/null; then
        echo "live /oem gate     : PATCHED"
    else
        echo "live /oem gate     : not patched (aiot_client can start before boot-hook.sh runs)"
    fi
    echo "ready flag         : $([ -f "$READY_FLAG" ] && echo present || echo absent)"
    echo "aiot_client.bin    : $(pidof aiot_client.bin >/dev/null 2>&1 && echo running || echo 'not running')"
}

mode_patch() {
    target="$(resolve_target)"

    if grep -q -F -e "$MARKER" "$target"; then
        echo "already patched: $target"
        return 0
    fi

    check_anchors "$target"

    # Backup is taken from the file being patched and only ever written once, so a
    # second patch after a firmware upgrade can't overwrite the pristine original.
    [ -f "$BACKUP" ] || cp "$target" "$BACKUP"

    guard=/tmp/valetudo-gate-guard.$$
    tmp=/tmp/valetudo-gate-new.$$
    write_guard "$guard"

    # Single awk pass: rewrite the call site, and insert the guard function after
    # LoopCount=0 so it is defined before the loop that uses it. Exact-string
    # comparisons throughout — no regex escaping of tabs or parens to get wrong.
    awk -v gf="$guard" -v call="$ANCHOR_CALL" -v loop="$ANCHOR_LOOP" '
        $0 == call { print "\t\tvaletudo_gate_open && checkwifiManager"; next }
        { print }
        $0 == loop { while ((getline line < gf) > 0) { print line } ; close(gf) }
    ' "$target" > "$tmp"

    if ! grep -q -F -e "$MARKER" "$tmp" || ! grep -q -F -e 'valetudo_gate_open && checkwifiManager' "$tmp"; then
        rm -f "$guard" "$tmp"
        echo "ERROR: rewrite produced a file missing the guard — $target left untouched." >&2
        exit 1
    fi
    if ! sh -n "$tmp"; then
        rm -f "$guard" "$tmp"
        echo "ERROR: rewritten wifi-deamon.sh does not parse — $target left untouched." >&2
        exit 1
    fi

    # `cat >` rather than `mv`: keeps the vendor file's own inode and mode, and
    # works across the /tmp -> /oem filesystem boundary either way.
    cat "$tmp" > "$target"
    sync
    rm -f "$guard" "$tmp"

    echo "patched: $target (original at $BACKUP)"
    echo "undo with: $0 unpatch"
}

mode_unpatch() {
    target="$(resolve_target)"

    if [ ! -f "$BACKUP" ]; then
        echo "ERROR: no $BACKUP to restore from." >&2
        exit 1
    fi

    cat "$BACKUP" > "$target"
    sync

    if grep -q -F -e "$MARKER" "$target"; then
        echo "ERROR: $target still contains the gate after restore." >&2
        exit 1
    fi

    echo "restored: $target from $BACKUP"
}

overlay_on() {
    # Checked on $OVERLAY_DIR alone, not the flag too: the copy is what's expensive
    # and precious (it may hold a patched/cert-swapped state newer than live /oem),
    # the flag is just a cheap on/off switch. Requiring both here once meant
    # re-running this after a manual `overlay off` would re-copy from the
    # now-stock live /oem, clobbering a good existing copy — exactly what almost
    # happened live on 2026-09-19. If you actually want a fresh copy, you have to
    # say so explicitly: `rm -rf $OVERLAY_DIR` first, then re-run this.
    if [ -d "$OVERLAY_DIR" ]; then
        touch "$OVERLAY_FLAG"
        sync
        echo "overlay copy already exists at $OVERLAY_DIR — re-armed the flag without touching its content."
        echo "(for a fresh copy from the current live /oem instead, rm -rf $OVERLAY_DIR first)"
        return 0
    fi

    need_kb=$(du -sk /oem | awk '{print $1}')
    avail_kb=$(df /userdata | tail -1 | awk '{print $4}')
    if [ "$avail_kb" -lt "$((need_kb + 20480))" ]; then
        echo "ERROR: /oem needs ${need_kb}KB, only ${avail_kb}KB free on /userdata (plus 20MB headroom)." >&2
        exit 1
    fi

    # S88scinit only does its own `cp -rf /oem/*` when /userdata/debug_dir is
    # absent, so pre-creating it here means boot uses this verified copy rather
    # than repeating the copy unsupervised during init.
    mkdir -p "$OVERLAY_DIR"
    cp -rf /oem/* "$OVERLAY_DIR/"
    sync

    if [ ! -x "$OVERLAY_DIR/bin/aiot_client.bin" ] || [ ! -x "$OVERLAY_DIR/bin/wifi-deamon.sh" ]; then
        echo "ERROR: copy looks incomplete — NOT setting $OVERLAY_FLAG." >&2
        echo "Reclaim with: rm -rf /userdata/debug_dir" >&2
        exit 1
    fi

    touch "$OVERLAY_FLAG"
    sync
    echo "overlay staged. Reboot, then run '$0 patch'."
    echo "undo with: $0 overlay off"
}

overlay_off() {
    rm -f "$OVERLAY_FLAG"
    sync
    echo "overlay flag removed — next boot uses the stock read-only /oem."
    echo "After that reboot, reclaim the space with: rm -rf /userdata/debug_dir"
}

case "${1:-}" in
    status) mode_status ;;
    patch) mode_patch ;;
    unpatch) mode_unpatch ;;
    overlay)
        case "${2:-}" in
            on) overlay_on ;;
            off) overlay_off ;;
            *) echo "usage: $0 overlay {on|off}" >&2; exit 1 ;;
        esac
        ;;
    *)
        echo "usage: $0 {status|patch|unpatch|overlay on|overlay off}" >&2
        exit 1
        ;;
esac
