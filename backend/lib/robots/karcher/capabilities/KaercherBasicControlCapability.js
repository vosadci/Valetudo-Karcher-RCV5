const BasicControlCapability = require("../../../core/capabilities/BasicControlCapability");

/**
 * doc/PROTOCOL.md §5: start/pause/stop all go through the same `set_room_clean`
 * service_invoke, distinguished only by `ctrl_value` (1=start/resume, 2=pause,
 * 0=stop-to-idle, all device-verified). `room_ids: []` does NOT mean "all rooms" —
 * the firmware picks one room semi-randomly — so a full-house start explicitly
 * passes every currently known room id.
 *
 * Zone (rectangle) cleaning (KaercherZoneCleaningCapability) is a genuinely separate
 * lifecycle: "Pause/resume must route through set_zone_clean, not set_room_clean.
 * The app decides this from the live work_mode" (doc/PROTOCOL.md §5) — so start/
 * stop/pause here check `robot.isZoneCleanActive()` first and, only while a zone
 * clean is actually in progress, route the same ctrl_value through set_zone_clean
 * instead. A fresh `start()` from idle always begins a room clean — zone cleans can
 * only be started via KaercherZoneCleaningCapability itself.
 *
 * Resuming a *paused room* clean is a third case, checked next via
 * `robot.isPaused()`: it reuses the same `set_room_clean`/`ctrl_value: 1` opcode as
 * a fresh start, but must send `room_ids: []` rather than the full segment list —
 * sending the fresh-start shape while paused made the robot self-check/relocalize
 * and begin an entirely new full-house clean instead of continuing, device-confirmed
 * live 2026-09-22 (see KaercherRCV5ValetudoRobot.isPaused()'s own header comment).
 *
 * ⚠ set_zone_clean itself is APK-derived, not yet device-capture-verified — see
 * KaercherZoneCleaningCapability's own header comment.
 *
 * @extends BasicControlCapability<import("../KaercherRCV5ValetudoRobot")>
 */
class KaercherBasicControlCapability extends BasicControlCapability {
    /**
     * @return {Promise<void>}
     */
    async start() {
        if (this.robot.isZoneCleanActive()) {
            await this.robot.sendServiceInvoke("set_zone_clean", {ctrl_value: 1});
            return;
        }

        if (this.robot.isPaused()) {
            await this.robot.sendServiceInvoke("set_room_clean", {
                room_ids: [],
                ctrl_value: 1,
                clean_type: 0
            });
            return;
        }

        const roomIds = this.robot.state.map.getSegments().map(segment => parseInt(segment.id, 10));

        if (roomIds.length === 0) {
            // No map/segments exist yet (first clean on a fresh device). set_room_clean's
            // empty room_ids does NOT mean "clean everywhere" on its own — the real app
            // (MapCreateTipActivity) only ever sends it *after* a separate build_map
            // command's reply confirms success; without that, set_room_clean{room_ids:[]}
            // is a silent no-op — device-confirmed live 2026-09-21 (three identical
            // attempts, MQTT delivery confirmed via aiot_client's own trace log, zero
            // reaction). build_map's params shape (`{ctrl_value: 1}`) is APK-derived from
            // MapsVM.buildMap(), not yet independently device-verified.
            await this.robot.startMapBuild();
            return;
        }

        await this.robot.sendServiceInvoke("set_room_clean", {
            room_ids: roomIds,
            ctrl_value: 1,
            clean_type: 0
        });
    }

    /**
     * @return {Promise<void>}
     */
    async stop() {
        if (this.robot.isZoneCleanActive()) {
            await this.robot.sendServiceInvoke("set_zone_clean", {ctrl_value: 0});
            return;
        }

        await this.robot.sendServiceInvoke("set_room_clean", {
            room_ids: [],
            ctrl_value: 0,
            clean_type: 0
        });
    }

    /**
     * @return {Promise<void>}
     */
    async pause() {
        if (this.robot.isZoneCleanActive()) {
            await this.robot.sendServiceInvoke("set_zone_clean", {ctrl_value: 2});
            return;
        }

        await this.robot.sendServiceInvoke("set_room_clean", {
            room_ids: [],
            ctrl_value: 2,
            clean_type: 0
        });
    }

    /**
     * @return {Promise<void>}
     */
    async home() {
        await this.robot.sendServiceInvoke("start_recharge", {});
    }
}

module.exports = KaercherBasicControlCapability;
