const KaercherMapParser = require("../KaercherMapParser");
const ZoneCleaningCapability = require("../../../core/capabilities/ZoneCleaningCapability");

/**
 * doc/PROTOCOL.md §5 "Area (zone) cleaning".
 *
 * ⚠ **APK-derived, not device-capture-verified.** Command names/topics/payload
 * shapes come from decompiled APK v1.4.32 (`ControlVM.setZonePoints`/`setZoneClean`),
 * not a real traffic capture. The coordinate units (`zone_points`, world metres) are
 * themselves inferred, not confirmed. Treat this capability as unverified until
 * tested live — a wrong coordinate transform here doesn't just fail, it could send
 * the robot to clean the wrong physical area.
 *
 * v1 of the protocol sends a single rectangle only — matches this capability's own
 * `zoneCount: {min: 1, max: 1}` below, so Valetudo's WebUI won't offer more than one.
 *
 * Pause/resume/stop while a zone clean is active are handled by
 * KaercherBasicControlCapability (checks `robot.isZoneCleanActive()`), not here.
 *
 * @extends ZoneCleaningCapability<import("../KaercherRCV5ValetudoRobot")>
 */
class KaercherZoneCleaningCapability extends ZoneCleaningCapability {
    /**
     * @param {object} options
     * @param {Array<import("../../../entities/core/ValetudoZone")>} options.zones
     * @return {Promise<void>}
     */
    async start(options) {
        const worldOrigin = this.robot.state.map?.metaData?.worldOrigin;

        if (!worldOrigin) {
            throw new Error("Cannot start zone cleaning: no map with a known world origin yet");
        }
        if (options.zones.length !== 1) {
            throw new Error("KaercherZoneCleaningCapability only supports a single zone");
        }

        const [zone] = options.zones;
        const corners = [zone.points.pA, zone.points.pB, zone.points.pC, zone.points.pD];
        const zonePoints = corners.flatMap(point => {
            const world = KaercherMapParser.VALETUDO_PIXELS_TO_WORLD(point.x, point.y, worldOrigin);

            return [world.x, world.y];
        });

        await this.robot.sendServiceInvoke("set_zone_points", {zone_points: zonePoints});
        await this.robot.sendServiceInvoke("set_zone_clean", {ctrl_value: 1});
        this.robot.setActiveCleanSegments([]);
    }

    /**
     * @return {import("../../../core/capabilities/ZoneCleaningCapability").ZoneCleaningCapabilityProperties}
     */
    getProperties() {
        return {
            zoneCount: {
                min: 1,
                max: 1
            },
            iterationCount: {
                min: 1,
                max: 1
            }
        };
    }
}

module.exports = KaercherZoneCleaningCapability;
