const entities = require("../../../entities");
const MapSegmentationCapability = require("../../../core/capabilities/MapSegmentationCapability");

const stateAttrs = entities.state.attributes;

/**
 * doc/PROTOCOL.md §5 "Notes on set_room_clean parameters": `room_ids` is an explicit
 * list — the same `set_room_clean` command KaercherBasicControlCapability uses for a
 * full-house start, just scoped to the selected segments.
 *
 * Custom order and repeat passes (doc/PROTOCOL.md §14 "Room Preferences") go through
 * a *separate*, APK-verified command, `set_preference` — the robot stores a per-map
 * preference table (order, mode, fan, water, repeat passes, material) that
 * `set_room_clean` itself carries no order information for and just reads implicitly.
 * This writes one row per requested segment (array order = cleaning order, `check:1`
 * so these per-room settings actually apply) before triggering the clean itself.
 *
 * mode/wind/water are read from the robot's *current global* preset settings
 * (KaercherRCV5ValetudoRobot.readCurrentRawValue) rather than passed in — Valetudo's
 * segment-clean action has no per-segment mode/fan/water parameters of its own, so
 * this applies whatever's currently selected uniformly to every room in this action,
 * same as before this feature existed; only order/repeat-count are new. Per-room
 * material (materialId) isn't tracked yet — always sent as 0 (hard floor).
 *
 * ⚠ Only ever writes rows for the segments in *this* action, not a full per-map
 * table read back from get_preference first — whether the device treats
 * set_preference as an upsert (leaves other rooms' stored settings alone) or a full
 * replace of the table is not yet confirmed. Worth checking via get_preference after
 * a live test before relying on any separately-set custom preferences surviving this.
 *
 * @extends MapSegmentationCapability<import("../KaercherRCV5ValetudoRobot")>
 */
class KaercherMapSegmentationCapability extends MapSegmentationCapability {
    /**
     * @param {Array<import("../../../entities/core/ValetudoMapSegment")>} segments
     * @param {object} [options]
     * @param {number} [options.iterations]
     * @param {boolean} [options.customOrder]
     * @return {Promise<void>}
     */
    async executeSegmentAction(segments, options) {
        const mapId = this.robot.ephemeralState.current_map_id;

        if (mapId === undefined) {
            throw new Error("Cannot set room preferences: current_map_id not yet known");
        }

        const iterations = Math.min(Math.max(options?.iterations ?? 1, 1), 3);
        const repeat = iterations - 1;

        const mode = this.robot.readCurrentRawValue(stateAttrs.PresetSelectionStateAttribute.TYPE.OPERATION_MODE, 0);
        const wind = this.robot.readCurrentRawValue(stateAttrs.PresetSelectionStateAttribute.TYPE.FAN_SPEED, 1);
        const water = this.robot.readCurrentRawValue(stateAttrs.PresetSelectionStateAttribute.TYPE.WATER_GRADE, 1);

        await this.robot.sendServiceInvoke("set_preference", {
            map_id: mapId,
            prefer_type: 1,
            room_preference: segments.map(segment => [
                parseInt(segment.id, 10), "", 0, mode, wind, water, repeat, 0, 1, 0, 0, 0
            ])
        });

        const roomIds = segments.map(segment => parseInt(segment.id, 10));

        await this.robot.sendServiceInvoke("set_room_clean", {
            room_ids: roomIds,
            ctrl_value: 1,
            clean_type: 0
        });
        this.robot.setActiveCleanSegments(roomIds);
    }

    /**
     * @return {import("../../../core/capabilities/MapSegmentationCapability").MapSegmentationCapabilityProperties}
     */
    getProperties() {
        return {
            iterationCount: {
                min: 1,
                max: 3
            },
            customOrderSupport: true
        };
    }
}

module.exports = KaercherMapSegmentationCapability;
