const Logger = require("../../Logger");
const Quirk = require("../../core/Quirk");

class KaercherQuirkFactory {
    /**
     * @param {object} options
     * @param {import("./KaercherRCV5ValetudoRobot")} options.robot
     */
    constructor(options) {
        this.robot = options.robot;
    }

    /**
     * @param {string} id
     * @returns {Quirk}
     */
    getQuirk(id) {
        switch (id) {
            case KaercherQuirkFactory.KNOWN_QUIRKS.CARPET_DISPLAY:
                return new Quirk({
                    id: id,
                    title: "Carpet Display",
                    // `privacy.carpet_show` (doc/APP_FEATURES.md "AI Recognition & Carpet
                    // Settings", APK-verified CarpetSettingVM.setCarpetShow). Live-confirmed
                    // (2026-09-24): this is a robot-side setting, not a Kärcher-app-side one —
                    // it controls whether the robot marks carpet cells in the map data it
                    // sends at all, which is what Valetudo renders. The robot has no cloud
                    // connection in this setup, so the Kärcher app is not in the loop.
                    description: "Whether detected carpet areas are shown on the map.",
                    options: ["on", "off"],
                    getter: async () => {
                        return this.robot.ephemeralState.privacy?.carpet_show === 1 ? "on" : "off";
                    },
                    setter: async (value) => {
                        let deviceValue;

                        switch (value) {
                            case "on":
                                deviceValue = 1;
                                break;
                            case "off":
                                deviceValue = 0;
                                break;
                            default:
                                throw new Error(`Received invalid value ${value}`);
                        }

                        await this.robot.sendPropertySet({privacy: {carpet_show: deviceValue}});

                        // Quiet setting the device may never echo back unprompted — same
                        // reasoning as KaercherSpeakerVolumeControlCapability.setVolume().
                        this.robot.sendPropertyGet().catch(e => {
                            Logger.warn("KaercherQuirkFactory: failed to refresh carpet_show state", e);
                        });
                    }
                });
            case KaercherQuirkFactory.KNOWN_QUIRKS.AUTO_UPGRADE:
                return new Quirk({
                    id: id,
                    title: "Automatic Firmware Updates",
                    // `privacy.auto_upgrade` (APK-verified: UpgradeVM.setAutoUpgrade(),
                    // DevPropertiesPrivacy.auto_upgrade). Same nested prop.set shape as
                    // CARPET_DISPLAY above. Confirmed present in the RobotApp firmware too
                    // (persisted in CDeviceConfig, read/written by real
                    // getAutoUpgradeStatus()/setAutoUpgradeStatus() functions) — this is a
                    // real robot-side setting, not just an app preference.
                    //
                    // What this is actually useful for: under normal Valetudo operation the
                    // robot has no route to Kärcher's real cloud at all (see
                    // karcher-cloud-switch.sh), so no OTA can reach it regardless of this
                    // flag. The real use case is the moment someone deliberately switches
                    // the robot back to cloud mode (e.g. to re-pair, or for a specific
                    // cloud-only task) — network blocking is off by definition at that
                    // point, and this is the one remaining lever against the robot picking
                    // up an unwanted firmware update while briefly back on the real cloud.
                    //
                    // Caveat, stated honestly: reverse-engineering (APK + firmware
                    // disassembly) confirmed this flag is real, persisted, and consulted
                    // somewhere in the upgrade code path, but did NOT conclusively trace
                    // whether it gates *acceptance* of a pushed update vs. only auto-*install*
                    // timing after a download. Treat "off" as the robot's own best-effort
                    // preference, not a guaranteed block — the network-level switch is still
                    // the confirmed control for keeping the robot off the real cloud at all.
                    //
                    // The device reports this field absent as -1 (not 0) when it has never
                    // been set — getter below only ever returns "on"/"off" via the same
                    // 1/0 convention every other privacy.* quirk uses, so an unset/-1 value
                    // reads as "off" here, which may not reflect the robot's true default.
                    description: "Whether the robot may install a firmware update pushed from " +
                        "3iRobotix/Kärcher's cloud. Only matters while the robot is connected " +
                        "to the real cloud (e.g. after switching back from Valetudo)",
                    options: ["on", "off"],
                    getter: async () => {
                        return this.robot.ephemeralState.privacy?.auto_upgrade === 1 ? "on" : "off";
                    },
                    setter: async (value) => {
                        let deviceValue;

                        switch (value) {
                            case "on":
                                deviceValue = 1;
                                break;
                            case "off":
                                deviceValue = 0;
                                break;
                            default:
                                throw new Error(`Received invalid value ${value}`);
                        }

                        await this.robot.sendPropertySet({privacy: {auto_upgrade: deviceValue}});

                        // Quiet setting the device may never echo back unprompted — same
                        // reasoning as KaercherSpeakerVolumeControlCapability.setVolume().
                        this.robot.sendPropertyGet().catch(e => {
                            Logger.warn("KaercherQuirkFactory: failed to refresh auto_upgrade state", e);
                        });
                    }
                });
            default:
                throw new Error(`There's no quirk with id ${id}`);
        }
    }
}

KaercherQuirkFactory.KNOWN_QUIRKS = {
    CARPET_DISPLAY: "b3c9b8d9-2f7e-4b3b-8a2c-6e2b1e6f8a9e",
    AUTO_UPGRADE: "d1a4e9b2-6c3f-4a5d-9e7b-2f8c1d6a3b90"
};

module.exports = KaercherQuirkFactory;
