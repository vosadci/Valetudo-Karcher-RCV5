const assert = require("node:assert");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, describe, it } = require("node:test");

const KaercherRCV5ValetudoRobot = require("../../../../lib/robots/karcher/KaercherRCV5ValetudoRobot");
const KaercherWebUiCert = require("../../../../lib/robots/karcher/KaercherWebUiCert");

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
                "MappingPassCapability",
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

    it("maps tank_state bits and cloth_state onto AttachmentStateAttribute", () => {
        const robot = buildRobot();
        const attached = (type) => robot.state.getFirstMatchingAttribute({attributeClass: "AttachmentStateAttribute", attributeType: type})?.attached;

        const cases = [
            {tank: 3, cloth: 1, dustbin: true, watertank: true, mop: true},
            {tank: 1, cloth: 0, dustbin: true, watertank: false, mop: false},
            {tank: 2, cloth: 0, dustbin: false, watertank: true, mop: false},
            {tank: 0, cloth: 0, dustbin: false, watertank: false, mop: false}
        ];

        for (const c of cases) {
            robot.parseAndUpdateState({tank_state: c.tank, cloth_state: c.cloth});
            assert.strictEqual(attached("dustbin"), c.dustbin);
            assert.strictEqual(attached("watertank"), c.watertank);
            assert.strictEqual(attached("mop"), c.mop);
        }
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

    describe("room clean marks", () => {
        // One room (id 10) in a 2x1 grid, the robot standing in it
        function robotMapWithRoom() {
            return {
                mapHead: {mapHeadId: 1, sizeX: 2, sizeY: 1, minX: 0, minY: 0, resolution: 0.05},
                mapData: {mapData: Buffer.from([10, 10])},
                currentPose: {x: 0.025, y: 0.025, phi: 0},
                roomDataInfo: [{roomId: 10, roomName: "Kitchen"}]
            };
        }

        function roomLayer(robot) {
            return robot.state.map.layers.find(l => l.metaData.segmentId === "10");
        }

        it("keeps the rooms through idle/docked pushes that arrive before cleaning starts", () => {
            const robot = buildRobot();
            robot.lastRobotMap = robotMapWithRoom();
            robot.parseAndUpdateState({work_mode: 0, status: 1, charge_state: 0, fault: 0});
            assert.strictEqual(robot.lastStatusValue, "idle");

            robot.setActiveCleanSegments([10]);
            robot.parseAndUpdateState({status: 4});
            assert.strictEqual(robot.lastStatusValue, "docked");

            assert.deepStrictEqual(robot.activeCleanSegmentIds, [10]);
            assert.strictEqual(roomLayer(robot).metaData.active, true);
        });

        it("clears the rooms and the current room when the clean ends", () => {
            const robot = buildRobot();
            robot.lastRobotMap = robotMapWithRoom();
            robot.setActiveCleanSegments([10]);
            robot.parseAndUpdateState({work_mode: 1, status: 1});
            robot.rebuildMap(); // stands in for the next map upload

            assert.strictEqual(robot.state.map.metaData.currentSegmentId, "10");

            robot.parseAndUpdateState({work_mode: 0, status: 4});

            assert.deepStrictEqual(robot.activeCleanSegmentIds, []);
            assert.strictEqual(roomLayer(robot).metaData.active, undefined);
            assert.strictEqual(robot.state.map.metaData.currentSegmentId, undefined);
        });

        it("says \"Moving to room\" while the robot drives between rooms", () => {
            const robot = buildRobot();
            const statusMessage = () => {
                return robot.state.getFirstMatchingAttribute({attributeClass: "StatusStateAttribute"}).message;
            };
            robot.lastRobotMap = robotMapWithRoom();
            robot.lastRobotMap.historyPose = {
                points: Array.from({length: 5}, () => {
                    return {x: 0.025, y: 0.025, update: 0};
                })
            };
            robot.parseAndUpdateState({work_mode: 1, status: 1});
            robot.rebuildMap(); // stands in for the next map upload

            assert.strictEqual(statusMessage(), "Moving to room");
            assert.strictEqual(robot.state.map.metaData.currentSegmentId, undefined);

            robot.parseAndUpdateState({work_mode: 0, status: 4});

            assert.strictEqual(statusMessage(), undefined);
        });

        it("names the next room of a room clean", () => {
            const robot = buildRobot();
            robot.lastRobotMap = robotMapWithRoom();
            robot.lastRobotMap.historyPose = {
                points: Array.from({length: 5}, () => {
                    return {x: 0.025, y: 0.025, update: 0};
                })
            };
            robot.setActiveCleanSegments([10]);
            robot.parseAndUpdateState({work_mode: 1, status: 1});
            robot.rebuildMap();

            assert.strictEqual(
                robot.state.getFirstMatchingAttribute({attributeClass: "StatusStateAttribute"}).message,
                "Moving to Kitchen"
            );
        });

        it("clears the rooms when the robot switches to another map", () => {
            const robot = buildRobot();
            robot.parseAndUpdateState({current_map_id: 1});
            robot.setActiveCleanSegments([10]);
            robot.parseAndUpdateState({current_map_id: 2});

            assert.deepStrictEqual(robot.activeCleanSegmentIds, []);
        });
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

    describe("sendPropertySet echo wait", () => {
        function buildRobotWithFakeCloud(publish) {
            const robot = buildRobot();

            robot.dummycloud = {publishCommand: publish};

            return robot;
        }

        it("resolves only once the robot's prop.post carries the sent value, so reads after the set see it", async () => {
            const robot = buildRobotWithFakeCloud(async () => undefined);
            let resolved = false;

            const pending = robot.sendPropertySet({privacy: {carpet_turbo: 1}}).then(() => {
                resolved = true;
            });

            // an unrelated echo and a stale value must not release the waiter
            robot.notifyPropPostWaiters({custom_type: 1});
            robot.notifyPropPostWaiters({privacy: {carpet_turbo: 0, carpet_avoid: 1}});
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(resolved, false);

            robot.notifyPropPostWaiters({privacy: {carpet_turbo: 1, carpet_avoid: 1}});
            await pending;

            assert.strictEqual(resolved, true);
            assert.strictEqual(robot.propPostWaiters.size, 0);
        });

        it("falls through after the timeout when the robot never echoes", async () => {
            const original = KaercherRCV5ValetudoRobot.SET_ECHO_TIMEOUT_MS;
            KaercherRCV5ValetudoRobot.SET_ECHO_TIMEOUT_MS = 20;

            try {
                const robot = buildRobotWithFakeCloud(async () => undefined);

                await robot.sendPropertySet({volume: 3});

                assert.strictEqual(robot.propPostWaiters.size, 0);
            } finally {
                KaercherRCV5ValetudoRobot.SET_ECHO_TIMEOUT_MS = original;
            }
        });

        it("rejects and leaves no waiter behind when the publish fails", async () => {
            const robot = buildRobotWithFakeCloud(async () => {
                throw new Error("no MQTT client connected");
            });

            await assert.rejects(robot.sendPropertySet({wind: 2}), /no MQTT client connected/);
            assert.strictEqual(robot.propPostWaiters.size, 0);
        });
    });

    describe("web UI HTTPS quirk", () => {
        const originalCertPath = KaercherRCV5ValetudoRobot.WEBUI_CERT_PATH;
        const originalKeyPath = KaercherRCV5ValetudoRobot.WEBUI_KEY_PATH;
        const originalIdentityPath = KaercherRCV5ValetudoRobot.IDENTITY_PATH;
        const originalPort = KaercherRCV5ValetudoRobot.WEBUI_HTTPS_PORT;
        const originalClockFloor = KaercherWebUiCert.CLOCK_FLOOR;
        const originalRetryMs = KaercherRCV5ValetudoRobot.WEBUI_HTTPS_CLOCK_RETRY_MS;
        let tmpDir;
        let robot;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaercher-webui-https-"));
            KaercherRCV5ValetudoRobot.WEBUI_CERT_PATH = path.join(tmpDir, "webui.crt");
            KaercherRCV5ValetudoRobot.WEBUI_KEY_PATH = path.join(tmpDir, "webui.key");
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = path.join(tmpDir, "device-identity.json");
            KaercherRCV5ValetudoRobot.WEBUI_HTTPS_PORT = 0; // ephemeral, avoids clashing on 8443
        });

        afterEach(() => {
            robot?.stopWebUiHttps();
            robot = undefined;
            KaercherRCV5ValetudoRobot.WEBUI_CERT_PATH = originalCertPath;
            KaercherRCV5ValetudoRobot.WEBUI_KEY_PATH = originalKeyPath;
            KaercherRCV5ValetudoRobot.IDENTITY_PATH = originalIdentityPath;
            KaercherRCV5ValetudoRobot.WEBUI_HTTPS_PORT = originalPort;
            KaercherRCV5ValetudoRobot.WEBUI_HTTPS_CLOCK_RETRY_MS = originalRetryMs;
            KaercherWebUiCert.CLOCK_FLOOR = originalClockFloor;
            fs.rmSync(tmpDir, {recursive: true, force: true});
        });

        async function waitForHttpsServer() {
            while (!robot.webUiHttpsServer || robot.webUiHttpsServer.address() === null) {
                await new Promise(resolve => {
                    setTimeout(resolve, 10);
                });
            }
        }

        it("is registered as a quirk that reflects and flips httpsEnabled", async () => {
            robot = buildRobot();
            const quirksCapability = robot.capabilities["QuirksCapability"];
            const quirk = quirksCapability.quirks.find(q => q.title === "Web UI HTTPS");

            assert.ok(quirk, "a 'Web UI HTTPS' quirk must be registered");
            assert.strictEqual(await quirk.getter(), "off");

            robot.webserverApp = (req, res) => {
                res.end("ok");
            };
            await quirk.setter("on");
            await waitForHttpsServer();

            assert.strictEqual(robot.httpsEnabled, true);
            assert.strictEqual(await quirk.getter(), "on");
        });

        it("persists the flag and serves the app over HTTPS when turned on", async () => {
            robot = buildRobot();
            robot.webserverApp = (req, res) => {
                res.end("ok");
            };

            await robot.setHttpsEnabled(true);
            await waitForHttpsServer();

            assert.strictEqual(
                JSON.parse(fs.readFileSync(KaercherRCV5ValetudoRobot.IDENTITY_PATH, "utf8")).httpsEnabled,
                true
            );

            const body = await new Promise((resolve, reject) => {
                https.get({
                    host: "127.0.0.1",
                    port: robot.webUiHttpsServer.address().port,
                    // Trusting the generated cert directly also proves its 127.0.0.1 SAN matches
                    ca: fs.readFileSync(KaercherRCV5ValetudoRobot.WEBUI_CERT_PATH)
                }, res => {
                    let data = "";

                    res.on("data", chunk => {
                        data += chunk;
                    });
                    res.on("end", () => {
                        resolve(data);
                    });
                }).on("error", reject);
            });

            assert.strictEqual(body, "ok");
        });

        it("stops the server and persists the flag when turned off", async () => {
            robot = buildRobot();
            robot.webserverApp = (req, res) => {
                res.end("ok");
            };

            await robot.setHttpsEnabled(true);
            await waitForHttpsServer();
            await robot.setHttpsEnabled(false);

            assert.strictEqual(robot.webUiHttpsServer, undefined);
            assert.strictEqual(
                JSON.parse(fs.readFileSync(KaercherRCV5ValetudoRobot.IDENTITY_PATH, "utf8")).httpsEnabled,
                false
            );
        });

        it("waits for a sane clock instead of generating a cert or a server", () => {
            KaercherWebUiCert.CLOCK_FLOOR = new Date(Date.UTC(2999, 0, 1));
            robot = buildRobot();
            robot.webserverApp = (req, res) => {
                res.end("ok");
            };

            robot.startWebUiHttps();

            assert.strictEqual(robot.webUiHttpsServer, undefined);
            assert.ok(robot.webUiCertClockTimeout);
            assert.strictEqual(fs.existsSync(KaercherRCV5ValetudoRobot.WEBUI_CERT_PATH), false);
        });
    });
});
