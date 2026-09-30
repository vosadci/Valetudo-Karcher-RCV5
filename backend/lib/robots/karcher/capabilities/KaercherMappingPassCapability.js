const MappingPassCapability = require("../../../core/capabilities/MappingPassCapability");

/**
 * "Create a new map" in the app (`MapCreateTipActivity`, decompiled APK v1.4.32) sends
 * `service.build_map {ctrl_value: 1}` — confirmed both client-side (`MapsVM.buildMap()`)
 * and firmware-side (`RobotApp` strings: `parseSetBuildMapModeEi`, `parseSetAIStartBuildMap`).
 * The app additionally guards this client-side (blocks with a dialog if `map_num >= 5`, or
 * if already faulted/mapping) — not mirrored here, the robot's own rejection (if any) is
 * left to surface on its own rather than duplicating unconfirmed client-side validation.
 *
 * @extends MappingPassCapability<import("../KaercherRCV5ValetudoRobot")>
 */
class KaercherMappingPassCapability extends MappingPassCapability {
    /**
     * @returns {Promise<void>}
     */
    async startMapping() {
        await this.robot.sendServiceInvoke("build_map", {ctrl_value: 1});
    }
}

module.exports = KaercherMappingPassCapability;
