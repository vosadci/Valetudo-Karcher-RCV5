const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, describe, it } = require("node:test");

const KaercherRCV5ValetudoRobot = require("../../../../lib/robots/karcher/KaercherRCV5ValetudoRobot");

// embedded: false skips dummycloud construction entirely (no TLS file reads, no port
// binds) — the same mode util/generate_robot_docs.js uses to instantiate robot
// classes without real hardware.
const FAKE_CONFIG = {
    get: (key) => key === "embedded" ? false : undefined
};

function buildRobot() {
    return new KaercherRCV5ValetudoRobot({config: FAKE_CONFIG, valetudoEventStore: {}});
}

describe("KaercherRCV5ValetudoRobot", () => {
    it("instantiates and registers the expected capabilities without a dummycloud", () => {
        const robot = buildRobot();

        assert.deepStrictEqual(
            Object.keys(robot.capabilities).sort(),
            [
                "BasicControlCapability",
                "CarpetModeControlCapability",
                "CarpetSensorModeControlCapability",
                "CombinedVirtualRestrictionsCapability",
                "ConsumableMonitoringCapability",
                "CurrentStatisticsCapability",
                "DoNotDisturbCapability",
                "FanSpeedControlCapability",
                "LocateCapability",
                "MapSegmentEditCapability",
                "MapSegmentRenameCapability",
                "MapSegmentationCapability",
                "ObstacleAvoidanceControlCapability",
                "OperationModeControlCapability",
                "QuirksCapability",
                "SpeakerTestCapability",
                "SpeakerVolumeControlCapability",
                "TotalStatisticsCapability",
                "WaterUsageControlCapability",
                "ZoneCleaningCapability"
            ],
            "AutoEmptyDockManualTriggerCapability must stay absent until hasAutoEmptyDock is persisted true"
        );
        assert.strictEqual(robot.dummycloud, undefined);
    });

    it("keeps the last known battery level when charge_state/fault change in a push without quantity", () => {
        // Regression test: charge_state and quantity arrive in separate partial
        // pushes (doc/PROTOCOL.md §6), but both affect the battery flag. An earlier
        // version of parseAndUpdateState only recomputed the flag when `quantity`
        // was present in the same push, leaving a docked+charge-finish push with no
        // quantity field stuck showing "discharging".
        const robot = buildRobot();

        robot.parseAndUpdateState({quantity: 87, charge_state: 0, fault: 0});
        let battery = robot.state.getFirstMatchingAttribute({attributeClass: "BatteryStateAttribute"});
        assert.strictEqual(battery.level, 87);
        assert.strictEqual(battery.flag, "discharging");

        robot.parseAndUpdateState({status: 4, work_mode: 0, charge_state: 1, fault: 2105});
        battery = robot.state.getFirstMatchingAttribute({attributeClass: "BatteryStateAttribute"});
        assert.strictEqual(battery.level, 87, "level should be carried over from the last push that had it");
        assert.strictEqual(battery.flag, "charged");
    });

    it("maps wind/water/mode prop.post pushes onto their preset attributes", () => {
        const robot = buildRobot();

        robot.parseAndUpdateState({wind: 3, water: 2, mode: 1});

        const fanSpeed = robot.state.getFirstMatchingAttribute({
            attributeClass: "PresetSelectionStateAttribute",
            attributeType: "fan_speed"
        });
        const waterGrade = robot.state.getFirstMatchingAttribute({
            attributeClass: "PresetSelectionStateAttribute",
            attributeType: "water_grade"
        });
        const operationMode = robot.state.getFirstMatchingAttribute({
            attributeClass: "PresetSelectionStateAttribute",
            attributeType: "operation_mode"
        });

        assert.strictEqual(fanSpeed.value, "max");
        assert.strictEqual(waterGrade.value, "high");
        assert.strictEqual(operationMode.value, "vacuum_and_mop");
    });

    it("maps dust_action pushes onto DockStatusStateAttribute", () => {
        const robot = buildRobot();

        robot.parseAndUpdateState({dust_action: 2});
        let dockStatus = robot.state.getFirstMatchingAttribute({attributeClass: "DockStatusStateAttribute"});
        assert.strictEqual(dockStatus.value, "emptying");

        robot.parseAndUpdateState({dust_action: 0});
        dockStatus = robot.state.getFirstMatchingAttribute({attributeClass: "DockStatusStateAttribute"});
        assert.strictEqual(dockStatus.value, "idle");
    });

    it("tracks current_map_id from prop.post pushes", () => {
        const robot = buildRobot();

        assert.strictEqual(robot.ephemeralState.current_map_id, undefined);
        robot.parseAndUpdateState({current_map_id: 7});
        assert.strictEqual(robot.ephemeralState.current_map_id, 7);
    });

    it("restores map/record upload defaults to 0 if a push shows either at 1, preserving every other privacy field", () => {
        // Regression test for a bug in an earlier revision: this code used to force
        // map_uploads/record_uploads to 1 on the mistaken theory that 1 meant
        // "upload consent granted" and that this gated carpet/AI-object map data.
        // The app's own UI (PrivacySecurityActivity.java) shows these toggles as ON
        // when the value is 0, so 0/0 was already the enabled default and the old
        // fix actually disabled uploads. This restores 0/0 if it's ever seen
        // flipped away from that.
        const robot = buildRobot();
        const sent = [];
        robot.sendPropertySet = async (params) => {
            sent.push(params);
        };

        robot.parseAndUpdateState({
            privacy: {
                ai_recognize: 1,
                dirt_recognize: 0,
                pet_recognize: 0,
                carpet_turbo: 1,
                carpet_avoid: 1,
                carpet_show: 1,
                map_uploads: 1,
                record_uploads: 1,
                auto_upgrade: 0
            }
        });

        assert.strictEqual(sent.length, 1);
        assert.deepStrictEqual(sent[0], {
            privacy: {
                ai_recognize: 1,
                dirt_recognize: 0,
                pet_recognize: 0,
                carpet_turbo: 1,
                carpet_avoid: 1,
                carpet_show: 1,
                map_uploads: 0,
                record_uploads: 0,
                auto_upgrade: 0
            }
        });
    });

    it("does not re-send once both upload flags already read the 0 default", () => {
        const robot = buildRobot();
        const sent = [];
        robot.sendPropertySet = async (params) => {
            sent.push(params);
        };

        robot.parseAndUpdateState({privacy: {map_uploads: 0, record_uploads: 0, carpet_show: 1}});

        assert.strictEqual(sent.length, 0);
    });

    it("caches ephemeralState.privacy as a merge, not a replace, across partial pushes", () => {
        // The APK sends one privacy sub-field at a time (CarpetSettingVM.setCarpetTurbo
        // etc.), so a partial echo/push must not blank out sibling fields already known.
        const robot = buildRobot();

        assert.strictEqual(robot.ephemeralState.privacy, undefined);

        robot.parseAndUpdateState({privacy: {carpet_turbo: 1}});
        assert.strictEqual(robot.ephemeralState.privacy.carpet_turbo, 1);

        robot.parseAndUpdateState({privacy: {carpet_avoid: 1}});
        assert.strictEqual(robot.ephemeralState.privacy.carpet_turbo, 1, "carpet_turbo must survive a sibling-only push");
        assert.strictEqual(robot.ephemeralState.privacy.carpet_avoid, 1);
    });

    describe("isZoneCleanActive", () => {
        it("is true only for the zone-clean work_mode family (30/31/32)", () => {
            const robot = buildRobot();

            for (const workMode of [30, 31, 32]) {
                robot.ephemeralState.work_mode = workMode;
                assert.strictEqual(robot.isZoneCleanActive(), true, `work_mode ${workMode}`);
            }
            for (const workMode of [undefined, 0, 1, 35]) {
                robot.ephemeralState.work_mode = workMode;
                assert.strictEqual(robot.isZoneCleanActive(), false, `work_mode ${workMode}`);
            }
        });
    });

    describe("isPaused", () => {
        it("is true for the generic PAUSE work_mode family (4/9/27/31/37/82)", () => {
            const robot = buildRobot();

            for (const workMode of [4, 9, 27, 31, 37, 82]) {
                robot.ephemeralState.work_mode = workMode;
                assert.strictEqual(robot.isPaused(), true, `work_mode ${workMode}`);
            }
            for (const workMode of [undefined, 0, 1, 30, 32, 35]) {
                robot.ephemeralState.work_mode = workMode;
                assert.strictEqual(robot.isPaused(), false, `work_mode ${workMode}`);
            }
        });
    });

    describe("readCurrentRawValue", () => {
        it("returns the fallback when the attribute has never been learned", () => {
            const robot = buildRobot();

            assert.strictEqual(robot.readCurrentRawValue("fan_speed", 1), 1);
        });

        it("returns the cached rawValue once a wind/water/mode push has been seen", () => {
            const robot = buildRobot();

            robot.parseAndUpdateState({wind: 3});
            assert.strictEqual(robot.readCurrentRawValue("fan_speed", 1), 3);
        });
    });

    describe("auto-empty dock capability gating", () => {
        // Regression coverage: CapabilitiesRouter and RobotMqttHandle both build
        // their route/handle trees once, from this.capabilities at THEIR OWN
        // startup — so a capability registered later, from a live
        // charge_station_type push, would silently 404 on its action endpoint
        // despite appearing to exist. The only correct place to decide is the
        // constructor, from a persisted value learned on a previous run.
        const scratchPath = path.join(os.tmpdir(), `karcher-auto-empty-test-${process.pid}.json`);
        const originalPath = KaercherRCV5ValetudoRobot.IDENTITY_PATH;

        afterEach(() => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = originalPath;
            try {
                fs.unlinkSync(scratchPath);
            } catch (e) {
                // Nothing to clean up if a test never wrote it.
            }
        });

        it("does not register the capability when no station presence was ever persisted", () => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = scratchPath;
            const robot = buildRobot();

            assert.strictEqual(robot.capabilities.AutoEmptyDockManualTriggerCapability, undefined);
        });

        it("registers the capability when hasAutoEmptyDock: true was persisted by a previous run", () => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = scratchPath;
            fs.writeFileSync(scratchPath, JSON.stringify({hasAutoEmptyDock: true}));

            const robot = buildRobot();

            assert.notStrictEqual(robot.capabilities.AutoEmptyDockManualTriggerCapability, undefined);
        });

        it("does not register the capability when hasAutoEmptyDock: false was persisted", () => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = scratchPath;
            fs.writeFileSync(scratchPath, JSON.stringify({hasAutoEmptyDock: false}));

            const robot = buildRobot();

            assert.strictEqual(robot.capabilities.AutoEmptyDockManualTriggerCapability, undefined);
        });

        it("persists charge_station_type as hasAutoEmptyDock without clobbering sn/mac", () => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = scratchPath;
            fs.writeFileSync(scratchPath, JSON.stringify({sn: "SG12345678", mac: "AA:BB:CC:DD:EE:FF"}));
            const robot = buildRobot();

            robot.parseAndUpdateState({charge_station_type: 1});

            assert.deepStrictEqual(robot.readKnownIdentity(), {
                sn: "SG12345678",
                mac: "AA:BB:CC:DD:EE:FF",
                hasAutoEmptyDock: true
            });

            robot.parseAndUpdateState({charge_station_type: 0});
            assert.strictEqual(robot.readKnownIdentity().hasAutoEmptyDock, false);
        });
    });

    describe("IMPLEMENTATION_AUTO_DETECTION_HANDLER", () => {
        it("returns false rather than throwing when productMode.ini doesn't exist", () => {
            assert.strictEqual(KaercherRCV5ValetudoRobot.IMPLEMENTATION_AUTO_DETECTION_HANDLER(), false);
        });
    });

    describe("device identity persistence", () => {
        // Regression coverage for the sn/mac reconnect bug: aiot_client doesn't
        // always redo a full HTTP login on every MQTT reconnect (cached sessions),
        // so sn/mac must survive a Valetudo restart rather than being re-learned
        // from scratch every time.
        const scratchPath = path.join(os.tmpdir(), `karcher-identity-test-${process.pid}.json`);
        const originalPath = KaercherRCV5ValetudoRobot.IDENTITY_PATH;

        afterEach(() => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = originalPath;
            try {
                fs.unlinkSync(scratchPath);
            } catch (e) {
                // Nothing to clean up if a test never wrote it.
            }
        });

        it("readKnownIdentity returns {} when no identity file exists yet", () => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = scratchPath;
            const robot = buildRobot();

            assert.deepStrictEqual(robot.readKnownIdentity(), {});
        });

        it("persistIdentity writes sn/mac, and readKnownIdentity reads them back", () => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = scratchPath;
            const robot = buildRobot();

            robot.persistIdentity("SG12345678", "AA:BB:CC:DD:EE:FF");

            assert.deepStrictEqual(robot.readKnownIdentity(), {sn: "SG12345678", mac: "AA:BB:CC:DD:EE:FF"});
        });
    });

    describe("getProperties", () => {
        const scratchPath = path.join(os.tmpdir(), `karcher-properties-test-${process.pid}.json`);
        const originalPath = KaercherRCV5ValetudoRobot.IDENTITY_PATH;

        afterEach(() => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = originalPath;
            try {
                fs.unlinkSync(scratchPath);
            } catch (e) {
                // Nothing to clean up if a test never wrote it.
            }
        });

        it("is empty when nothing is known yet (no persisted identity, no firmware push)", () => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = scratchPath;
            const robot = buildRobot();

            assert.deepStrictEqual(robot.getProperties(), {});
        });

        it("surfaces sn/mac from the persisted identity file when no dummycloud is running", () => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = scratchPath;
            const robot = buildRobot();

            robot.persistIdentity("SG12345678", "AA:BB:CC:DD:EE:FF");

            assert.deepStrictEqual(robot.getProperties(), {
                serialNumber: "SG12345678",
                macAddress: "AA:BB:CC:DD:EE:FF"
            });
        });

        it("prefers the live dummycloud sn/mac over the on-disk copy once known", () => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = scratchPath;
            const robot = buildRobot();

            robot.persistIdentity("SG-STALE-DISK", "AA:BB:CC:DD:EE:FF");
            robot.dummycloud = {sn: "SG-LIVE", mac: "11:22:33:44:55:66"};

            assert.deepStrictEqual(robot.getProperties(), {
                serialNumber: "SG-LIVE",
                macAddress: "11:22:33:44:55:66"
            });
        });

        it("surfaces firmware from a prop push, preferring `firmware` over `firmware_code` when both are present", () => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = scratchPath;
            const robot = buildRobot();

            robot.parseAndUpdateState({firmware: "1.2.3", firmware_code: "99"});

            assert.strictEqual(robot.getProperties().firmwareVersion, "1.2.3");
        });

        it("falls back to firmware_code when firmware itself is absent", () => {
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = scratchPath;
            const robot = buildRobot();

            robot.parseAndUpdateState({firmware_code: "99"});

            assert.strictEqual(robot.getProperties().firmwareVersion, "99");
        });
    });
});
