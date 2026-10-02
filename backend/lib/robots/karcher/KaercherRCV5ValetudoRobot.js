const fs = require("fs");
const https = require("https");

const capabilities = require("./capabilities");
const entities = require("../../entities");
const KaercherAiotDummycloud = require("./KaercherAiotDummycloud");
const KaercherCameraRouter = require("./KaercherCameraRouter");
const KaercherCameraStream = require("./camera/KaercherCameraStream");
const KaercherConst = require("./KaercherConst");
const KaercherMapParser = require("./KaercherMapParser");
const KaercherMapsRouter = require("./KaercherMapsRouter");
const KaercherQuirkFactory = require("./KaercherQuirkFactory");
const KaercherStateDerivation = require("./KaercherStateDerivation");
const KaercherStaticTLSContext = require("./KaercherStaticTLSContext");
const KaercherWebUiCert = require("./KaercherWebUiCert");
const KaercherWifiApController = require("./KaercherWifiApController");
const LinuxWifiScanCapability = require("../common/linuxCapabilities/LinuxWifiScanCapability");
const Logger = require("../../Logger");
const QuirksCapability = require("../../core/capabilities/QuirksCapability");
const Tools = require("../../utils/Tools");
const TotalStatisticsCapability = require("../../core/capabilities/TotalStatisticsCapability");
const ValetudoRobot = require("../../core/ValetudoRobot");
const ValetudoRobotError = require("../../entities/core/ValetudoRobotError");

const stateAttrs = entities.state.attributes;

class KaercherRCV5ValetudoRobot extends ValetudoRobot {
    /**
     * @param {object} options
     * @param {import("../../Configuration")} options.config
     * @param {import("../../ValetudoEventStore")} options.valetudoEventStore
     */
    constructor(options) {
        super(options);

        // Same fields the work_mode/status decision tree and battery flag need,
        // cached across partial prop.post pushes (the device never sends a full
        // snapshot unprompted — see doc/PROTOCOL.md §6).
        /** @type {Set<{params: object, resolve: () => void}>} */
        this.propPostWaiters = new Set();
        /** @type {Set<(list: Array<{id: number, name: string, cur: boolean}>) => void>} */
        this.mapListWaiters = new Set();
        this.snapshotRetries = 0;
        this.cameraStream = new KaercherCameraStream();
        // Rooms of the room clean Valetudo started, shown as `active` on the map. The robot
        // never reports them itself, so they are lost when Valetudo restarts mid-clean.
        /** @type {Array<number>} */
        this.activeCleanSegmentIds = [];
        // Last decoded map upload, kept so the map can be rebuilt when the cleaning state
        // changes between uploads (the robot may stop uploading once it docks).
        this.lastRobotMap = null;
        this.lastStatusValue = undefined;

        this.ephemeralState = {
            work_mode: undefined,
            status: undefined,
            charge_state: undefined,
            fault: undefined,
            quantity: undefined,
            main_brush: undefined,
            side_brush: undefined,
            hypa: undefined,
            mop_life: undefined,
            cleaning_time: undefined,
            cleaning_area: undefined,
            // Surfaced via getProperties() (WELL_KNOWN_PROPERTIES.FIRMWARE_VERSION).
            // Both are in ROBOT_PROPERTIES' confirmed-from-the-real-app section
            // (KaercherConst.js); `firmware` is preferred when both are present, see
            // getProperties() below — live-confirmed 2026-09-22 (shows e.g. "I3.12.90",
            // matching the version reported by the robot's own firmware update check).
            firmware: undefined,
            firmware_code: undefined,
            // Needed by KaercherMapSegmentationCapability's set_preference calls
            // (doc/PROTOCOL.md §14) — the preference table is keyed per map_id.
            current_map_id: undefined,
            // Read by KaercherSpeakerVolumeControlCapability.getVolume() — no
            // synchronous query exists, only cached prop.post/prop.get pushes.
            // `alarm` isn't cached separately: KaercherSpeakerVolumeControlCapability
            // derives it from `volume` rather than reading the device's own echo back.
            volume: undefined,
            // Read by KaercherCarpetModeControlCapability, KaercherCarpetSensorModeControlCapability,
            // KaercherObstacleAvoidanceControlCapability, and KaercherQuirkFactory's
            // carpet_show quirk. Merged (not replaced) in parseAndUpdateState — the
            // APK sends one privacy sub-field at a time (e.g. CarpetSettingVM.
            // setCarpetTurbo only puts "carpet_turbo" in its payload), so a naive
            // replace would blank the other three fields on every partial echo.
            privacy: undefined,
            // Read by KaercherDoNotDisturbCapability (PoC — see
            // temporal-honking-treasure.md "Add Do Not Disturb" section, not yet finished).
            // quiet_begin_time/quiet_end_time/time_zone are not in the app's own prop.get
            // request list — unconfirmed whether a poll actually returns them, see
            // KaercherConst.ROBOT_PROPERTIES.
            quiet_is_open: undefined,
            quiet_begin_time: undefined,
            quiet_end_time: undefined,
            time_zone: undefined
        };

        const knownIdentity = this.readKnownIdentity();

        if (this.config.get("embedded") === true) {
            const cert = fs.readFileSync(KaercherRCV5ValetudoRobot.CERT_PATH, "utf8");
            const key = fs.readFileSync(KaercherRCV5ValetudoRobot.KEY_PATH, "utf8");

            this.dummycloud = new KaercherAiotDummycloud({
                tlsContext: new KaercherStaticTLSContext({cert: cert, key: key}),
                bindIP: KaercherRCV5ValetudoRobot.BIND_IP,
                knownSn: knownIdentity.sn,
                knownMac: knownIdentity.mac,
                onConnected: () => {
                    // Mirrors what the real cloud does per project_rcv5_valetudo_step7_live_confirmed
                    // memory: it doesn't matter whether this re-serves an existing map or
                    // prompts a fresh one, so just always ask for a refresh on connect.
                    this.sendServiceInvoke("upload_by_maptype", {map_type: 0}).catch(e => {
                        Logger.warn("KaercherRCV5ValetudoRobot: failed to request a map refresh", e);
                    });
                    // Without this, state only ever reflects whatever the robot happens to
                    // push unprompted — confirmed live 2026-09-18 that fields like `water`
                    // can go an entire session without ever being pushed, leaving
                    // WaterUsageControlCapability's WebUI widget stuck on "Error loading"
                    // (no PresetSelectionStateAttribute had ever been set). The real app
                    // does exactly this request on every connect (karcher-home's
                    // request_device_update()) — mirrored here for the same reason.
                    this.sendPropertyGet().catch(e => {
                        Logger.warn("KaercherRCV5ValetudoRobot: failed to request a full property snapshot", e);
                    });
                },
                onIncomingCloudMessage: (topic, envelope) => {
                    if (envelope?.method === "prop.post" && envelope.params) {
                        this.parseAndUpdateState(envelope.params);
                        this.notifyPropPostWaiters(envelope.params);
                    } else if (topic.endsWith("/service/property/get_reply") && envelope?.code === 0 && envelope.data) {
                        // Reply to sendPropertyGet() — a different envelope shape entirely
                        // ({code, data}, not {method, params}), confirmed against
                        // karcher-home's own _process_mqtt_message()/_update_device_properties(),
                        // which dispatches purely by topic rather than by any method field.
                        this.handlePropertySnapshot(envelope.data);
                    } else if (topic.endsWith("/service_invoke_reply/set_quiet_time")) {
                        // PoC diagnostic (KaercherDoNotDisturbCapability) — previously silently
                        // dropped, since nothing registered a reply_listener for this specific
                        // service_invoke_reply. Just logging the raw envelope here rather than
                        // building the full reply-listener plumbing get_preference uses, since
                        // this is purely to confirm the robot actually accepted set_quiet_time.
                        Logger.info(
                            `KaercherRCV5ValetudoRobot: set_quiet_time reply: ${JSON.stringify(envelope)}`
                        );
                    } else if (topic.endsWith("/event/clean_record/post")) {
                        // Unprompted push after each clean, per-record — see
                        // KaercherTotalStatisticsCapability.js header comment. Logging the raw
                        // envelope until the field names/units are live-confirmed.
                        Logger.info(
                            `KaercherRCV5ValetudoRobot: clean_record event: ${JSON.stringify(envelope)}`
                        );
                        this.capabilities[TotalStatisticsCapability.TYPE]?.handleCleanRecordEvent(envelope.params);
                    } else if (topic.endsWith("/service_invoke_reply/get_map_list")) {
                        Logger.info(
                            `KaercherRCV5ValetudoRobot: get_map_list reply: ${JSON.stringify(envelope)}`
                        );
                        this.notifyMapListWaiters(envelope);
                    } else if (topic.endsWith("/service_invoke_reply/set_cur_map")) {
                        Logger.info(
                            `KaercherRCV5ValetudoRobot: set_cur_map reply: ${JSON.stringify(envelope)}`
                        );
                    } else if (topic.endsWith("/service_invoke_reply/del_map")) {
                        Logger.info(
                            `KaercherRCV5ValetudoRobot: del_map reply: ${JSON.stringify(envelope)}`
                        );
                    } else if (topic.endsWith("/service_invoke_reply/rename_map")) {
                        Logger.info(
                            `KaercherRCV5ValetudoRobot: rename_map reply: ${JSON.stringify(envelope)}`
                        );
                    } else if (topic.endsWith("/service_invoke_reply/build_map")) {
                        // Diagnostic (KaercherMappingPassCapability) — not live-tested yet, no
                        // known failure mode (map_num >= 5, already mapping, etc.) to react to
                        // programmatically. Just logging the raw envelope for now, same as
                        // set_quiet_time above.
                        Logger.info(
                            `KaercherRCV5ValetudoRobot: build_map reply: ${JSON.stringify(envelope)}`
                        );
                    }
                },
                onSpecificUseUpload: (dir, body) => {
                    this.handleSpecificUseUpload(dir, body);
                },
                onIdentityLearned: (sn, mac) => {
                    this.persistIdentity(sn, mac);
                }
            });
        }

        // Static across restarts, same reasoning as sn/mac persistence above: the
        // Suction Station RCV 5 is a physically-attached accessory, sold separately
        // (project_auto_empty_dock memory), so whether it's present doesn't change
        // within a boot session. Deciding this HERE, synchronously from the last
        // persisted value, is required, not just convenient — WebServer's
        // CapabilitiesRouter and MQTT's RobotMqttHandle both build their route/handle
        // trees once from `this.capabilities` at their own startup (confirmed by
        // reading both), so registering the capability later from a live
        // charge_station_type push would silently 404 on every actual action
        // endpoint despite appearing to exist.
        this.knownHasAutoEmptyDock = knownIdentity.hasAutoEmptyDock;

        // The camera feed is only reachable through the unauthenticated RTSP port while it runs,
        // so it stays off until the user turns it on.
        this.cameraEnabled = knownIdentity.cameraEnabled === true;

        // Self-signed HTTPS for the web UI. Off by default; toggled by the HTTPS quirk and
        // persisted here so it comes back up after a reboot.
        this.httpsEnabled = knownIdentity.httpsEnabled === true;

        /** @type {Array<new (options: {robot: KaercherRCV5ValetudoRobot}) => import("../../core/capabilities/Capability")>} */
        const capabilitiesToRegister = [
            capabilities.KaercherBasicControlCapability,
            capabilities.KaercherFanSpeedControlCapability,
            capabilities.KaercherWaterUsageControlCapability,
            capabilities.KaercherOperationModeControlCapability,
            capabilities.KaercherSpeakerTestCapability,
            capabilities.KaercherSpeakerVolumeControlCapability,
            capabilities.KaercherLocateCapability,
            capabilities.KaercherConsumableMonitoringCapability,
            capabilities.KaercherCurrentStatisticsCapability,
            capabilities.KaercherTotalStatisticsCapability,
            capabilities.KaercherMapSegmentationCapability,
            capabilities.KaercherMappingPassCapability,
            capabilities.KaercherZoneCleaningCapability,
            capabilities.KaercherCombinedVirtualRestrictionsCapability,
            capabilities.KaercherMapSegmentEditCapability,
            capabilities.KaercherMapSegmentRenameCapability,
            capabilities.KaercherCarpetModeControlCapability,
            capabilities.KaercherCarpetSensorModeControlCapability,
            capabilities.KaercherObstacleAvoidanceControlCapability,
            // PoC — see KaercherDoNotDisturbCapability.js header comment.
            capabilities.KaercherDoNotDisturbCapability
        ];

        if (this.knownHasAutoEmptyDock === true) {
            capabilitiesToRegister.push(capabilities.KaercherAutoEmptyDockManualTriggerCapability);
        }

        capabilitiesToRegister.forEach(capability => {
            this.registerCapability(new capability({robot: this}));
        });

        // Wi-Fi status/scan take a networkInterface option the generic forEach above
        // doesn't supply, and only make sense when actually running on the robot itself
        // (matches DreameValetudoRobot.js's own embedded gate for LinuxWifiScanCapability).
        if (this.config.get("embedded") === true) {
            this.registerCapability(new capabilities.KaercherWifiConfigurationCapability({
                robot: this,
                networkInterface: "wlan0"
            }));
            this.registerCapability(new LinuxWifiScanCapability({
                robot: this,
                networkInterface: "wlan0"
            }));

            this.wifiApController = new KaercherWifiApController({robot: this});
            this.wifiApController.start();
        }

        const quirkFactory = new KaercherQuirkFactory({robot: this});
        this.registerCapability(new QuirksCapability({
            robot: this,
            quirks: [
                quirkFactory.getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.CARPET_DISPLAY),
                quirkFactory.getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.AUTO_UPGRADE),
                quirkFactory.getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.CAMERA),
                quirkFactory.getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.WEBUI_HTTPS)
            ]
        }));

        this.state.upsertFirstMatchingAttribute(new stateAttrs.StatusStateAttribute({
            value: stateAttrs.StatusStateAttribute.VALUE.IDLE
        }));
    }

    async shutdown() {
        this.stopWebUiHttps();

        await this.cameraStream.shutdown();
        await super.shutdown();

        if (this.dummycloud) {
            await this.dummycloud.shutdown();
        }

        if (this.wifiApController) {
            this.wifiApController.stop();
        }
    }

    /**
     * sn/mac are static per physical device — persisting them once means every
     * later restart already knows both, regardless of whether the robot's
     * aiot_client redoes a full HTTP login or just reconnects MQTT with a cached
     * session (confirmed live 2026-09-18 that it doesn't always redo the login).
     * Without this, mac specifically has no other recovery path at all (unlike
     * sn, it isn't derivable from MQTT traffic), so map decryption would keep
     * silently failing until the next real login happened to occur.
     *
     * @protected
     * @return {{sn?: string, mac?: string, hasAutoEmptyDock?: boolean, cameraEnabled?: boolean, httpsEnabled?: boolean}}
     */
    readKnownIdentity() {
        try {
            return JSON.parse(fs.readFileSync(KaercherRCV5ValetudoRobot.IDENTITY_PATH, "utf8"));
        } catch (e) {
            Logger.info("KaercherRCV5ValetudoRobot: no persisted device identity yet", e.message);
            return {};
        }
    }

    /**
     * @protected
     * @param {string} sn
     * @param {string} mac
     */
    persistIdentity(sn, mac) {
        this.persistDeviceState({sn: sn, mac: mac});
    }

    /**
     * @param {boolean} enabled
     */
    async setCameraEnabled(enabled) {
        this.cameraEnabled = enabled;
        this.persistDeviceState({cameraEnabled: enabled});

        if (!enabled) {
            await this.cameraStream.shutdown();
        }
    }

    /**
     * @protected
     * @param {boolean} present
     */
    persistStationPresence(present) {
        this.persistDeviceState({hasAutoEmptyDock: present});
    }

    /**
     * Merges into the persisted file rather than overwriting it outright — sn/mac
     * and hasAutoEmptyDock are learned independently, at different times, and
     * neither should wipe the other out.
     *
     * @protected
     * @param {object} patch
     */
    persistDeviceState(patch) {
        try {
            const current = this.readKnownIdentity();

            fs.writeFileSync(
                KaercherRCV5ValetudoRobot.IDENTITY_PATH,
                JSON.stringify(Object.assign({}, current, patch))
            );
        } catch (e) {
            Logger.warn("KaercherRCV5ValetudoRobot: failed to persist device state", e);
        }
    }

    /**
     * @param {string} dir the S3 object path the upload arrived for
     * @param {Buffer} body raw PUT body
     */
    handleSpecificUseUpload(dir, body) {
        // Only the primary `temp/_1` slot is parsed — confirmed live this session to
        // be the one carrying current_pose/history_pose and the newest
        // map_upload_date; `_2` is an older, pose-less snapshot with identical grid
        // data, `_3` was empty. See project_rcv5_valetudo_step7_live_confirmed memory.
        if (!dir.includes("/map/temp/") || !dir.endsWith("_1")) {
            Logger.debug(`KaercherRCV5ValetudoRobot: ignoring upload for dir='${dir}'`);
            return;
        }
        if (!this.dummycloud.sn || !this.dummycloud.mac) {
            Logger.warn("KaercherRCV5ValetudoRobot: received a map upload before sn/mac were known, dropping it");
            return;
        }

        const parser = new KaercherMapParser({
            sn: this.dummycloud.sn,
            mac: this.dummycloud.mac,
            productId: KaercherAiotDummycloud.PRODUCT_ID
        });
        const robotMap = parser.decode(body);

        if (robotMap) {
            this.lastRobotMap = robotMap;
            this.rebuildMap();
        }
    }

    /**
     * @private
     */
    rebuildMap() {
        if (!this.lastRobotMap) {
            return;
        }

        const map = KaercherMapParser.BUILD_VALETUDO_MAP(this.lastRobotMap, {
            activeSegmentIds: this.activeCleanSegmentIds,
            trackCurrentRoom: this.lastStatusValue === stateAttrs.StatusStateAttribute.VALUE.CLEANING
        });

        if (map) {
            this.state.map = map;
            this.emitMapUpdated();
        }
    }

    /**
     * Called by the clean-starting capabilities: the rooms of a room clean, or [] for a
     * whole-home or zone clean.
     *
     * @param {Array<number>} segmentIds
     */
    setActiveCleanSegments(segmentIds) {
        const changed = segmentIds.length !== this.activeCleanSegmentIds.length ||
            segmentIds.some(id => !this.activeCleanSegmentIds.includes(id));

        this.activeCleanSegmentIds = segmentIds;

        if (changed) {
            this.rebuildMap();
        }
    }

    /**
     * Ends the room clean's `active` marks when a clean finishes, and drops the current
     * room once the robot stops cleaning. Only a change out of a running state counts:
     * the robot can still report docked once or twice after set_room_clean, and that
     * must not clear the rooms that were just set.
     *
     * @private
     * @param {string} statusValue
     */
    handleCleanStateChange(statusValue) {
        const previous = this.lastStatusValue;
        const VALUE = stateAttrs.StatusStateAttribute.VALUE;

        if (statusValue === previous) {
            return;
        }
        this.lastStatusValue = statusValue;

        const wasRunning = [VALUE.CLEANING, VALUE.PAUSED, VALUE.RETURNING, VALUE.MOVING].includes(previous);
        const isFinished = [VALUE.IDLE, VALUE.DOCKED].includes(statusValue);

        if (wasRunning && isFinished && this.activeCleanSegmentIds.length > 0) {
            this.activeCleanSegmentIds = [];
            this.rebuildMap();
        } else if (previous === VALUE.CLEANING) {
            // No rebuild when cleaning starts: the cached upload's path may still be the
            // previous clean's, so the current room waits for the next upload.
            this.rebuildMap();
        }
    }

    /**
     * doc/PROTOCOL.md §5: service_invoke commands, topic
     * `service_invoke/{serviceName}`, method `service.{serviceName}`, version "3.0".
     *
     * @param {string} serviceName
     * @param {object} params
     * @return {Promise<void>}
     */
    async sendServiceInvoke(serviceName, params) {
        return this.dummycloud.publishCommand(`service_invoke/${serviceName}`, `service.${serviceName}`, params, "3.0");
    }

    /**
     * doc/PROTOCOL.md §5: fan speed/water/cleaning mode all go through this single
     * topic+method, version "1.0" — confirmed by live capture, distinct from
     * service_invoke's "3.0".
     *
     * @param {object} params e.g. {wind: 2}, {water: 1}, {mode: 0}
     * @return {Promise<void>}
     */
    async sendPropertySet(params) {
        // The robot acknowledges a set before it has applied it: a prop.get sent right after
        // still returns the old value, and the new value only arrives as a prop.post a few
        // ms later (live capture 2026-09-30, privacy.carpet_turbo). publishCommand() resolves
        // on publish, so without waiting for that echo every capability's read-after-write
        // returns stale state and the WebUI needs a second press. Falls through on timeout
        // for properties the robot never echoes.
        const echoed = this.waitForPropPostEcho(params, KaercherRCV5ValetudoRobot.SET_ECHO_TIMEOUT_MS);

        try {
            await this.dummycloud.publishCommand("service/property/set", "prop.set", params, "1.0");
        } catch (e) {
            this.cancelPropPostWait(echoed);
            throw e;
        }

        await echoed.promise;
    }

    /**
     * Asks the robot for its saved maps. The reply shape is APK-derived
     * (`{map_list: [{id, name, cur}]}`), not live-confirmed, so it may sit under `data` or `params`.
     *
     * @return {Promise<Array<{id: number, name: string, cur: boolean}>>}
     */
    async requestMapList() {
        const reply = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.mapListWaiters.delete(onReply);
                reject(new Error("The robot did not answer the map list request in time"));
            }, KaercherRCV5ValetudoRobot.MAP_LIST_TIMEOUT_MS);
            const onReply = (list) => {
                clearTimeout(timer);
                resolve(list);
            };

            this.mapListWaiters.add(onReply);
        });

        try {
            await this.sendServiceInvoke("get_map_list", {});
        } catch (e) {
            this.mapListWaiters.clear();
            throw e;
        }

        return reply;
    }

    /**
     * Two steps, like the app's MapCreateTipActivity: build_map arms it, and only its successful
     * reply is followed by a whole-house set_room_clean, which is what makes the robot leave the dock.
     * The robot acks build_map with result 0 but does nothing until the clean is sent
     * (live 2026-09-30: build_map alone left the robot idle).
     *
     * @return {Promise<void>}
     */
    async startMapBuild() {
        await this.sendServiceInvoke("build_map", {ctrl_value: 1});
        await new Promise((resolve) => {
            setTimeout(resolve, KaercherRCV5ValetudoRobot.MAP_CHANGE_SETTLE_MS);
        });
        await this.sendServiceInvoke("set_room_clean", {room_ids: [], ctrl_value: 1, clean_type: 0});
    }

    /**
     * @param {number} id
     * @param {string} name
     * @return {Promise<Array<{id: number, name: string, cur: boolean}>>}
     */
    async renameMap(id, name) {
        return this.changeMaps("rename_map", {map_id: id, map_name: name});
    }

    /**
     * @param {number} id
     * @return {Promise<Array<{id: number, name: string, cur: boolean}>>}
     */
    async selectMap(id) {
        const maps = await this.changeMaps("set_cur_map", {map_id: id});

        // The robot doesn't push the newly active map on its own (unconfirmed), so ask for it like on connect
        this.sendServiceInvoke("upload_by_maptype", {map_type: 0}).catch(e => {
            Logger.warn("KaercherRCV5ValetudoRobot: failed to request the map after switching", e);
        });

        return maps;
    }

    /**
     * @param {number} id
     * @return {Promise<Array<{id: number, name: string, cur: boolean}>>}
     */
    async deleteMap(id) {
        return this.changeMaps("del_map", {map_id: id});
    }

    /**
     * The robot acks before it applies a change, so the list is only requested after a short delay.
     *
     * @private
     * @param {string} service
     * @param {object} params
     * @return {Promise<Array<{id: number, name: string, cur: boolean}>>}
     */
    async changeMaps(service, params) {
        await this.sendServiceInvoke(service, params);
        await new Promise((resolve) => {
            setTimeout(resolve, KaercherRCV5ValetudoRobot.MAP_CHANGE_SETTLE_MS);
        });

        return this.requestMapList();
    }

    /**
     * @param {any} envelope
     */
    notifyMapListWaiters(envelope) {
        const rawList = (envelope?.data ?? envelope?.params)?.map_list;

        if (!Array.isArray(rawList)) {
            return;
        }

        const list = rawList.map((map) => {
            return {id: Number(map.id), name: String(map.name ?? ""), cur: Boolean(map.cur)};
        });

        this.mapListWaiters.forEach((waiter) => {
            waiter(list);
        });
        this.mapListWaiters.clear();
    }

    initModelSpecificWebserverRoutes(app) {
        super.initModelSpecificWebserverRoutes(app);

        app.use("/api/v2/karcher/maps/", new KaercherMapsRouter({robot: this}).getRouter());
        app.use("/api/v2/karcher/camera/", new KaercherCameraRouter({
            cameraStream: this.cameraStream,
            isEnabled: () => {
                return this.cameraEnabled;
            }
        }).getRouter());

        // Kept so the HTTPS quirk can (re)start a second server on the same app at
        // runtime. This runs inside the core WebServer, so the whole app — auth,
        // routes, UI — is already wired by the time we get it.
        this.webserverApp = app;

        if (this.httpsEnabled) {
            this.startWebUiHttps();
        }
    }

    /**
     * Toggled by the "Web UI HTTPS" quirk. Persists like cameraEnabled so it survives a
     * reboot, and starts or stops the second (HTTPS) server right away.
     *
     * @param {boolean} enabled
     */
    async setHttpsEnabled(enabled) {
        this.httpsEnabled = enabled;
        this.persistDeviceState({httpsEnabled: enabled});

        if (enabled) {
            this.startWebUiHttps();
        } else {
            this.stopWebUiHttps();
        }
    }

    /**
     * Runs a self-signed HTTPS server next to the core HTTP one, on the same express
     * app, so auth and every route apply unchanged. The cert is generated on the robot
     * (no openssl CLI there) and persisted, so browsers keep their accepted exception
     * across reboots. Waits for a sane clock first because the cert's validity window is
     * anchored to the current time. Deliberately not wired into core WebServer — keeping
     * it here keeps the fork's core diff at zero and upstream merges clean.
     *
     * @private
     */
    startWebUiHttps() {
        if (this.webUiHttpsServer || this.webserverApp === undefined) {
            return;
        }

        if (!KaercherWebUiCert.IS_CLOCK_SANE(new Date())) {
            if (this.webUiCertClockWaitLogged !== true) {
                Logger.info("KaercherRCV5ValetudoRobot: clock not set yet, delaying web UI HTTPS");
                this.webUiCertClockWaitLogged = true;
            }
            this.webUiCertClockTimeout = setTimeout(() => {
                this.startWebUiHttps();
            }, KaercherRCV5ValetudoRobot.WEBUI_HTTPS_CLOCK_RETRY_MS);

            return;
        }

        KaercherWebUiCert.LOAD_OR_GENERATE({
            certPath: KaercherRCV5ValetudoRobot.WEBUI_CERT_PATH,
            keyPath: KaercherRCV5ValetudoRobot.WEBUI_KEY_PATH,
            hostnames: [Tools.GET_ZEROCONF_HOSTNAME(), "localhost"],
            ips: ["127.0.0.1", ...Tools.GET_CURRENT_HOST_IP_ADDRESSES()],
            now: new Date()
        }).then(tls => {
            if (!this.httpsEnabled) { // disabled again while the cert was generating
                return;
            }

            this.webUiHttpsServer = https.createServer(tls, this.webserverApp);
            this.webUiHttpsServer.on("error", e => {
                Logger.error("KaercherRCV5ValetudoRobot: web UI HTTPS server error", e);
            });
            this.webUiHttpsServer.listen(KaercherRCV5ValetudoRobot.WEBUI_HTTPS_PORT, () => {
                Logger.info("Webserver (HTTPS) running on port", KaercherRCV5ValetudoRobot.WEBUI_HTTPS_PORT);
            });
        }).catch(e => {
            Logger.error("KaercherRCV5ValetudoRobot: failed to set up web UI HTTPS", e);
        });
    }

    /**
     * @private
     */
    stopWebUiHttps() {
        clearTimeout(this.webUiCertClockTimeout);

        if (this.webUiHttpsServer) {
            this.webUiHttpsServer.close();
            this.webUiHttpsServer = undefined;
        }
    }

    /**
     * @param {object} params properties as sent in a prop.set
     * @param {number} timeoutMs
     * @return {{promise: Promise<void>, waiter: {params: object, resolve: () => void}}}
     */
    waitForPropPostEcho(params, timeoutMs) {
        let waiter;
        const promise = new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.propPostWaiters.delete(waiter);
                Logger.debug(`KaercherRCV5ValetudoRobot: no prop.post echo for ${JSON.stringify(params)} within ${timeoutMs}ms`);
                resolve();
            }, timeoutMs);

            waiter = {
                params: params,
                resolve: () => {
                    clearTimeout(timer);
                    resolve();
                }
            };
            this.propPostWaiters.add(waiter);
        });

        return {promise: promise, waiter: waiter};
    }

    /**
     * @param {{waiter: {params: object, resolve: () => void}}} echo
     */
    cancelPropPostWait(echo) {
        this.propPostWaiters.delete(echo.waiter);
        echo.waiter.resolve();
    }

    /**
     * Resolves every pending set whose sent values are all present in this prop.post.
     *
     * @param {object} posted
     */
    notifyPropPostWaiters(posted) {
        const isSubset = (sent, actual) => {
            return Object.entries(sent).every(([key, value]) => {
                if (typeof value === "object" && value !== null) {
                    return typeof actual?.[key] === "object" && actual[key] !== null && isSubset(value, actual[key]);
                }

                return actual?.[key] === value;
            });
        };

        this.propPostWaiters.forEach((waiter) => {
            if (isSubset(waiter.params, posted)) {
                this.propPostWaiters.delete(waiter);
                waiter.resolve();
            }
        });
    }

    /**
     * Requests a full property snapshot. Ported verbatim from the installed
     * `karcher-home` package's `request_device_update()`: topic
     * `service/property/get`, method `prop.get`, version "3.0" (distinct from
     * prop.set's "1.0"), params `{property: [...]}`. The robot replies on
     * `service/property/get_reply` with a `{code, data}` envelope — handled
     * separately in the constructor's onIncomingCloudMessage, not the {method,
     * params} shape prop.post/service_invoke_reply use.
     *
     * @return {Promise<void>}
     */
    async sendPropertyGet() {
        return this.dummycloud.publishCommand("service/property/get", "prop.get", {property: KaercherConst.ROBOT_PROPERTIES}, "3.0");
    }

    /**
     * Straight after a boot the robot answers prop.get from a zeroed struct (live 2026-09-30:
     * status -1, mode -21, water -11, quantity 0, map_num 0). Applying it shows 0% battery until the
     * next push, which for quantity only comes when the level changes. status -1 marks that reply, so it
     * is dropped and the request repeated until the robot has real values.
     *
     * @param {object} data
     */
    handlePropertySnapshot(data) {
        if (data?.status !== -1) {
            this.snapshotRetries = 0;
            this.parseAndUpdateState(data);
            return;
        }

        if (this.snapshotRetries >= KaercherRCV5ValetudoRobot.SNAPSHOT_MAX_RETRIES) {
            Logger.warn("KaercherRCV5ValetudoRobot: the robot kept answering prop.get with placeholder values, giving up");
            return;
        }

        this.snapshotRetries++;
        Logger.debug(`KaercherRCV5ValetudoRobot: ignoring placeholder prop.get reply (retry ${this.snapshotRetries})`);
        setTimeout(() => {
            this.sendPropertyGet().catch(e => {
                Logger.warn("KaercherRCV5ValetudoRobot: failed to repeat the property snapshot request", e);
            });
        }, KaercherRCV5ValetudoRobot.SNAPSHOT_RETRY_MS);
    }

    /**
     * @param {object} data flat property object from a prop.post push — may be partial
     */
    parseAndUpdateState(data) {
        if (typeof data !== "object" || data === null) {
            return;
        }

        // Diagnostic for KaercherMappingPassCapability: build_map is accepted but nothing visibly starts
        const mappingKeys = ["build_map", "has_new_map", "new_map_notify", "map_num", "current_map_id", "status", "work_mode"];
        const mappingFields = Object.fromEntries(mappingKeys.filter(key => data[key] !== undefined).map(key => [key, data[key]]));

        if (data.build_map !== undefined || data.has_new_map !== undefined || data.new_map_notify !== undefined) {
            Logger.info(`KaercherRCV5ValetudoRobot: mapping state: ${JSON.stringify(mappingFields)}`);
        }

        let statusRelevant = false;
        for (const key of ["work_mode", "status", "charge_state", "fault"]) {
            if (data[key] !== undefined) {
                this.ephemeralState[key] = data[key];
                statusRelevant = true;
            }
        }
        if (data.current_map_id !== undefined && data.current_map_id !== this.ephemeralState.current_map_id) {
            // Room ids belong to one map
            this.setActiveCleanSegments([]);
        }
        for (const key of ["main_brush", "side_brush", "hypa", "mop_life", "current_map_id", "cleaning_time", "cleaning_area", "volume", "firmware", "firmware_code"]) {
            if (data[key] !== undefined) {
                this.ephemeralState[key] = data[key];
            }
        }

        // DND PoC (KaercherDoNotDisturbCapability) — flat fields, as distinct from the
        // nested quiet_status object below. See KaercherConst.ROBOT_PROPERTIES for the
        // caveat that these two representations may not both actually arrive.
        for (const key of ["quiet_is_open", "quiet_begin_time", "quiet_end_time", "time_zone"]) {
            if (data[key] !== undefined) {
                this.ephemeralState[key] = data[key];
            }
        }

        // Nested alternative representation of the same setting (doc/PROTOCOL.md findings,
        // DND PoC) — mapped onto the same flat ephemeralState fields KaercherDoNotDisturbCapability
        // reads, since it's unconfirmed which representation (flat vs. nested) the robot
        // actually sends on a given push/poll.
        if (data.quiet_status !== undefined) {
            if (data.quiet_status.begin_time !== undefined) {
                this.ephemeralState.quiet_begin_time = data.quiet_status.begin_time;
            }
            if (data.quiet_status.end_time !== undefined) {
                this.ephemeralState.quiet_end_time = data.quiet_status.end_time;
            }
        }

        // PoC diagnostic — see KaercherDoNotDisturbCapability.js. Logs only when at least one
        // of these fields is actually present in this particular push/reply, so it also answers
        // "does a prop.get reply ever include these at all" (KaercherConst.ROBOT_PROPERTIES
        // caveat) just by whether this line appears.
        if (
            data.quiet_is_open !== undefined || data.quiet_begin_time !== undefined ||
            data.quiet_end_time !== undefined || data.time_zone !== undefined ||
            data.quiet_status !== undefined
        ) {
            Logger.info(
                "KaercherRCV5ValetudoRobot: DND-related fields in incoming data: " +
                `quiet_is_open=${data.quiet_is_open} quiet_begin_time=${data.quiet_begin_time} ` +
                `quiet_end_time=${data.quiet_end_time} time_zone=${data.time_zone} ` +
                `quiet_status=${JSON.stringify(data.quiet_status)}`
            );
        }

        // Merged, not replaced — see the ephemeralState.privacy comment in the
        // constructor for why a straight assignment would lose sibling fields.
        if (data.privacy !== undefined) {
            this.ephemeralState.privacy = {...this.ephemeralState.privacy, ...data.privacy};
        }

        // A previous revision of this code force-set map_uploads/record_uploads to
        // 1, on the mistaken assumption that 1 meant "consent granted" and that
        // this consent gated the carpet/AI-object data missing from map uploads.
        // Both were wrong: the app's own UI (PrivacySecurityActivity.java) shows
        // these toggles as ON when the value is 0 — so the observed 0/0 was
        // already the enabled default, and forcing 1/1 actually disabled uploads.
        // (The real carpet gap was unrelated: the RCV5 encodes carpet as grid
        // bytes in mapData, not via furniture_info — see KaercherMapParser.
        // DECODE_CELL.) This restores the 0/0 default if the earlier bug flipped
        // it; harmless no-op once it has.
        if (
            data.privacy !== undefined &&
            (data.privacy.map_uploads !== 0 || data.privacy.record_uploads !== 0)
        ) {
            this.sendPropertySet({
                privacy: {...data.privacy, map_uploads: 0, record_uploads: 0}
            }).catch(e => {
                Logger.warn("KaercherRCV5ValetudoRobot: failed to restore map/record upload defaults", e);
            });
        }

        if (data.quantity !== undefined) {
            this.ephemeralState.quantity = data.quantity;
        }

        // charge_state/fault arrive independently of quantity (partial pushes), but
        // both affect the battery flag — refresh it whenever either changes, as long
        // as a level is already known. Missed this the first time: a docked+charge-
        // finish push with no quantity field left the flag stale at "discharging".
        if ((data.quantity !== undefined || statusRelevant) && this.ephemeralState.quantity !== undefined) {
            this.state.upsertFirstMatchingAttribute(new stateAttrs.BatteryStateAttribute({
                level: this.ephemeralState.quantity,
                flag: this.getBatteryFlag()
            }));
        }

        if (statusRelevant) {
            this.updateStatusAttribute();
        }

        if (data.wind !== undefined) {
            this.state.upsertFirstMatchingAttribute(new stateAttrs.PresetSelectionStateAttribute({
                type: stateAttrs.PresetSelectionStateAttribute.TYPE.FAN_SPEED,
                value: KaercherConst.WIND_TO_PRESET[data.wind] ?? stateAttrs.PresetSelectionStateAttribute.INTENSITY.CUSTOM,
                customValue: KaercherConst.WIND_TO_PRESET[data.wind] === undefined ? data.wind : undefined,
                metaData: {rawValue: data.wind}
            }));
        }

        if (data.water !== undefined) {
            this.state.upsertFirstMatchingAttribute(new stateAttrs.PresetSelectionStateAttribute({
                type: stateAttrs.PresetSelectionStateAttribute.TYPE.WATER_GRADE,
                value: KaercherConst.WATER_TO_PRESET[data.water] ?? stateAttrs.PresetSelectionStateAttribute.INTENSITY.CUSTOM,
                customValue: KaercherConst.WATER_TO_PRESET[data.water] === undefined ? data.water : undefined,
                metaData: {rawValue: data.water}
            }));
        }

        if (data.mode !== undefined) {
            this.state.upsertFirstMatchingAttribute(new stateAttrs.PresetSelectionStateAttribute({
                type: stateAttrs.PresetSelectionStateAttribute.TYPE.OPERATION_MODE,
                value: KaercherConst.MODE_TO_PRESET[data.mode] ?? stateAttrs.PresetSelectionStateAttribute.INTENSITY.CUSTOM,
                customValue: KaercherConst.MODE_TO_PRESET[data.mode] === undefined ? data.mode : undefined,
                metaData: {rawValue: data.mode}
            }));
        }

        if (data.tank_state !== undefined) {
            this.upsertAttachment(stateAttrs.AttachmentStateAttribute.TYPE.WATERTANK, (data.tank_state & KaercherConst.TANK_STATE_WATERTANK_BIT) !== 0, data.tank_state);
            this.upsertAttachment(stateAttrs.AttachmentStateAttribute.TYPE.DUSTBIN, (data.tank_state & KaercherConst.TANK_STATE_DUSTBIN_BIT) !== 0, data.tank_state);
        }

        if (data.cloth_state !== undefined) {
            this.upsertAttachment(stateAttrs.AttachmentStateAttribute.TYPE.MOP, data.cloth_state === 1, data.cloth_state);
        }

        if (data.charge_station_type !== undefined) {
            const hasStation = data.charge_station_type !== 0;

            if (this.knownHasAutoEmptyDock !== hasStation) {
                this.knownHasAutoEmptyDock = hasStation;
                this.persistStationPresence(hasStation);
            }
        }

        if (data.dust_action !== undefined) {
            // Suction Station RCV 5: dust_action cycles 0 (idle) -> 2 (emptying) -> 0
            // over ~20s (device-confirmed, karcher-rcv5-ha's project_auto_empty_dock
            // memory). `1` has never been observed. station_act is deliberately NOT
            // used here — it stays 0 throughout a real empty cycle on this hardware.
            this.state.upsertFirstMatchingAttribute(new stateAttrs.DockStatusStateAttribute({
                value: data.dust_action === 2 ?
                    stateAttrs.DockStatusStateAttribute.VALUE.EMPTYING :
                    stateAttrs.DockStatusStateAttribute.VALUE.IDLE,
                metaData: {rawValue: data.dust_action}
            }));
        }

        this.emitStateAttributesUpdated();
    }

    /**
     * @param {import("../../entities/state/attributes/AttachmentStateAttribute").AttachmentStateAttributeType} type
     * @param {boolean} attached
     * @param {number} rawValue
     */
    upsertAttachment(type, attached, rawValue) {
        this.state.upsertFirstMatchingAttribute(new stateAttrs.AttachmentStateAttribute({
            type: type,
            attached: attached,
            metaData: {rawValue: rawValue}
        }));
    }

    /**
     * @protected
     * @return {import("../../entities/state/attributes/BatteryStateAttribute").BatteryStateAttributeFlag}
     */
    getBatteryFlag() {
        return KaercherStateDerivation.deriveBatteryFlag(this.ephemeralState);
    }

    /**
     * doc/PROTOCOL.md §5 "Area (zone) cleaning" — see KaercherConst.ZONE_WORK_MODES'
     * own comment for why idle is deliberately excluded here. Called from
     * KaercherBasicControlCapability, not just internally.
     *
     * @return {boolean}
     */
    isZoneCleanActive() {
        return KaercherConst.ZONE_WORK_MODES.includes(this.ephemeralState.work_mode);
    }

    /**
     * doc/PROTOCOL.md §5: resuming a paused room clean must send `room_ids: []`
     * (not the full room list) alongside `ctrl_value: 1` — the same "start" opcode
     * used for a fresh clean, but the firmware only treats it as "continue" while
     * work_mode is still PAUSE; a fresh-start-shaped payload (explicit room ids)
     * makes it self-check/relocalize and begin a brand-new full-house clean
     * instead, device-confirmed live 2026-09-22. Zone-clean pausing (work_mode 31)
     * is excluded here since KaercherBasicControlCapability already routes that
     * case through isZoneCleanActive() first, which never needs an explicit room
     * list to begin with.
     *
     * @return {boolean}
     */
    isPaused() {
        return KaercherConst.WORK_MODE_SETS.PAUSE.includes(this.ephemeralState.work_mode);
    }

    /**
     * Reads back the raw device value behind a currently-known preset attribute
     * (stashed as metaData.rawValue whenever wind/water/mode pushes are parsed) —
     * used by KaercherMapSegmentationCapability to carry the robot's current global
     * mode/fan/water settings into a per-room set_preference write, since Valetudo's
     * segment-clean action doesn't take per-segment mode/fan/water parameters itself.
     *
     * Called from KaercherMapSegmentationCapability, not just internally.
     *
     * @param {string} attributeType one of PresetSelectionStateAttribute.TYPE
     * @param {number} fallback used only if this attribute has never been learned yet
     * @return {number}
     */
    readCurrentRawValue(attributeType, fallback) {
        const attribute = this.state.getFirstMatchingAttribute({
            attributeClass: "PresetSelectionStateAttribute",
            attributeType: attributeType
        });

        return attribute?.metaData?.rawValue ?? fallback;
    }

    /**
     * @protected
     */
    updateStatusAttribute() {
        const {value, faultCode, statusMessage} = KaercherStateDerivation.deriveStatus(this.ephemeralState);

        this.state.upsertFirstMatchingAttribute(new stateAttrs.StatusStateAttribute({
            value: value,
            error: faultCode !== undefined ? this.buildRobotError(faultCode) : undefined,
            message: statusMessage
        }));

        this.handleCleanStateChange(value);
    }

    /**
     * @protected
     * @param {number} faultCode
     * @return {ValetudoRobotError}
     */
    buildRobotError(faultCode) {
        return new ValetudoRobotError({
            severity: {
                kind: ValetudoRobotError.SEVERITY_KIND.UNKNOWN,
                level: ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN
            },
            subsystem: ValetudoRobotError.SUBSYSTEM.UNKNOWN,
            message: KaercherConst.FAULT_MESSAGES[faultCode] ?? `Fault ${faultCode}`,
            vendorErrorCode: `${faultCode}`
        });
    }

    getModelDetails() {
        return Object.assign(
            {},
            super.getModelDetails(),
            {
                supportedAttachments: [
                    stateAttrs.AttachmentStateAttribute.TYPE.DUSTBIN,
                    stateAttrs.AttachmentStateAttribute.TYPE.WATERTANK,
                    stateAttrs.AttachmentStateAttribute.TYPE.MOP,
                ]
            }
        );
    }

    getManufacturer() {
        return "Kärcher";
    }

    getModelName() {
        return "RCV 5";
    }

    /**
     * sn/mac: prefer the live in-memory dummycloud values (kept current across an
     * onIdentityLearned re-login) over the on-disk copy, falling back to disk only
     * before the dummycloud has learned them this session — same fallback
     * readKnownIdentity() itself exists for (see its own header comment).
     *
     * firmware: `firmware` preferred over `firmware_code` when both are present —
     * live-confirmed 2026-09-22 to yield a human-readable version string (e.g.
     * "I3.12.90"), see the ephemeralState field comment above.
     *
     * @return {object}
     */
    getProperties() {
        const superProps = super.getProperties();
        const ourProps = {};
        const identity = this.dummycloud?.sn !== undefined ? this.dummycloud : this.readKnownIdentity();

        if (identity?.sn !== undefined) {
            ourProps[KaercherRCV5ValetudoRobot.WELL_KNOWN_PROPERTIES.SERIAL_NUMBER] = identity.sn;
        }
        if (identity?.mac !== undefined) {
            ourProps[KaercherRCV5ValetudoRobot.WELL_KNOWN_PROPERTIES.MAC_ADDRESS] = identity.mac;
        }

        const firmwareVersion = this.ephemeralState.firmware ?? this.ephemeralState.firmware_code;

        if (firmwareVersion !== undefined) {
            ourProps[KaercherRCV5ValetudoRobot.WELL_KNOWN_PROPERTIES.FIRMWARE_VERSION] = firmwareVersion;
        }

        return Object.assign({}, superProps, ourProps);
    }

    static IMPLEMENTATION_AUTO_DETECTION_HANDLER() {
        let productMode;

        try {
            productMode = fs.readFileSync("/oem/sysconf/productMode.ini", "utf8");
        } catch (e) {
            Logger.trace("cannot read", "/oem/sysconf/productMode.ini", e);
            return false;
        }

        return productMode.includes("product_mode=Kaercher.KaercherRCV5Es");
    }
}

// On-device deployment path — everything Valetudo-owned lives under one directory
// (binary, config, log, certs, identity file), consolidated 2026-09-18. The dev-test
// harness at contrib/karcher-rcv5/{server_v1.crt,server.key} is the source these
// get copied from, not where they run from on the robot.
KaercherRCV5ValetudoRobot.CERT_PATH = "/userdata/valetudo/server_v1.crt";
KaercherRCV5ValetudoRobot.KEY_PATH = "/userdata/valetudo/server.key";
// Persisted sn/mac/hasAutoEmptyDock, learned once and reused on every later restart —
// see readKnownIdentity()/persistDeviceState() above for why this exists.
KaercherRCV5ValetudoRobot.IDENTITY_PATH = "/userdata/valetudo/device-identity.json";
// Self-signed web UI cert, generated on first HTTPS start — see KaercherWebUiCert
KaercherRCV5ValetudoRobot.WEBUI_CERT_PATH = "/userdata/valetudo/webui.crt";
KaercherRCV5ValetudoRobot.WEBUI_KEY_PATH = "/userdata/valetudo/webui.key";
// 8443, not 443: the dummycloud binds 127.0.13.38:443 and on Linux a 0.0.0.0:443
// listener would collide with it.
KaercherRCV5ValetudoRobot.WEBUI_HTTPS_PORT = 8443;
KaercherRCV5ValetudoRobot.WEBUI_HTTPS_CLOCK_RETRY_MS = 30 * 1000;
// Defaults to the real on-device loopback-alias bind (see KaercherAiotDummycloud.BIND_IP's
// own comment) — only correct once Valetudo actually runs ON the robot. Dev-Mac test
// harnesses running Valetudo remotely need to override this to "0.0.0.0" instead, the
// same way contrib/karcher-rcv5/dev/run_dummycloud.js already does for
// KaercherAiotDummycloud directly.
KaercherRCV5ValetudoRobot.BIND_IP = KaercherAiotDummycloud.BIND_IP;

/** Upper bound on how long a prop.set waits for the robot's prop.post echo. */
KaercherRCV5ValetudoRobot.SET_ECHO_TIMEOUT_MS = 1500;
KaercherRCV5ValetudoRobot.MAP_LIST_TIMEOUT_MS = 5000;
KaercherRCV5ValetudoRobot.SNAPSHOT_RETRY_MS = 5000;
KaercherRCV5ValetudoRobot.SNAPSHOT_MAX_RETRIES = 12;
KaercherRCV5ValetudoRobot.MAP_CHANGE_SETTLE_MS = 500;

module.exports = KaercherRCV5ValetudoRobot;
