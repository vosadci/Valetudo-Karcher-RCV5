const LocateCapability = require("../../../core/capabilities/LocateCapability");

/**
 * Same wire command as KaercherSpeakerTestCapability: `service.find_device`
 * (doc/PROTOCOL.md §5, APK-derived SettingsVM.findDevice(), no params).
 * Live-confirmed via KaercherSpeakerTestCapability's use of the identical call.
 *
 * @extends LocateCapability<import("../KaercherRCV5ValetudoRobot")>
 */
class KaercherLocateCapability extends LocateCapability {
    /**
     * @returns {Promise<void>}
     */
    async locate() {
        await this.robot.sendServiceInvoke("find_device", {});
    }
}

module.exports = KaercherLocateCapability;
