# Sourced by the vendor's /etc/init.d/S99_auto_reboot on every boot — do not
# set -e, do not exit, do not reference $1/$@ (S99 passes the Rockchip QA
# reboot counter there; sourcing means those would apply to S99_auto_reboot's
# own shell, not just this file). Keep this file inert; real logic lives in
# boot-hook.sh, which S99 backgrounds implicitly and which is invoked
# normally (a real subprocess, not sourced), so it can safely use set -u/exit.
#
# Deploy to /userdata/cfg/rockchip_test/auto_reboot.sh — see README.md
# "Why the boot hook is two files" for the source/execute split this exists
# for, and "Checking the robot's state" for why this local path is
# device/auto_reboot.sh (not this repo's own on-device deploy path).

[ -x /userdata/valetudo/boot-hook.sh ] && /userdata/valetudo/boot-hook.sh
