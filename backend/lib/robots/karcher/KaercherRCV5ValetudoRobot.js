const fs = require("fs");

const capabilities = require("./capabilities");
const entities = require("../../entities");
const KaercherAiotDummycloud = require("./KaercherAiotDummycloud");
const KaercherConst = require("./KaercherConst");
const KaercherMapParser = require("./KaercherMapParser");
const KaercherQuirkFactory = require("./KaercherQuirkFactory");
const KaercherStateDerivation = require("./KaercherStateDerivation");
const KaercherStaticTLSContext = require("./KaercherStaticTLSContext");
const Logger = require("../../Logger");
const QuirksCapability = require("../../core/capabilities/QuirksCapability");
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
                    } else if (topic.endsWith("/service/property/get_reply") && envelope?.code === 0 && envelope.data) {
                        // Reply to sendPropertyGet() — a different envelope shape entirely
                        // ({code, data}, not {method, params}), confirmed against
                        // karcher-home's own _process_mqtt_message()/_update_device_properties(),
                        // which dispatches purely by topic rather than by any method field.
                        this.parseAndUpdateState(envelope.data);
                    } else if (topic.endsWith("/service_invoke_reply/set_quiet_time")) {
                        // PoC diagnostic (KaercherDoNotDisturbCapability) — previously silently
                        // dropped, since nothing registered a reply_listener for this specific
                        // service_invoke_reply. Just logging the raw envelope here rather than
                        // building the full reply-listener plumbing get_preference uses, since
                        // this is purely to confirm the robot actually accepted set_quiet_time.
                        Logger.info(
                            `KaercherRCV5ValetudoRobot: set_quiet_time reply: ${JSON.stringify(envelope)}`
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

        /** @type {Array<new (options: {robot: KaercherRCV5ValetudoRobot}) => import("../../core/capabilities/Capability")>} */
        const capabilitiesToRegister = [
            capabilities.KaercherBasicControlCapability,
            capabilities.KaercherFanSpeedControlCapability,
            capabilities.KaercherWaterUsageControlCapability,
            capabilities.KaercherOperationModeControlCapability,
            capabilities.KaercherSpeakerTestCapability,
            capabilities.KaercherSpeakerVolumeControlCapability,
            capabilities.KaercherConsumableMonitoringCapability,
            capabilities.KaercherCurrentStatisticsCapability,
            capabilities.KaercherMapSegmentationCapability,
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

        const quirkFactory = new KaercherQuirkFactory({robot: this});
        this.registerCapability(new QuirksCapability({
            robot: this,
            quirks: [
                quirkFactory.getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.CARPET_DISPLAY)
            ]
        }));

        this.state.upsertFirstMatchingAttribute(new stateAttrs.StatusStateAttribute({
            value: stateAttrs.StatusStateAttribute.VALUE.IDLE
        }));
    }

    async shutdown() {
        await super.shutdown();

        if (this.dummycloud) {
            await this.dummycloud.shutdown();
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
     * @return {{sn?: string, mac?: string, hasAutoEmptyDock?: boolean}}
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
        const map = parser.parse(body);

        if (map) {
            this.state.map = map;
            this.emitMapUpdated();
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
        return this.dummycloud.publishCommand("service/property/set", "prop.set", params, "1.0");
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
     * @param {object} data flat property object from a prop.post push — may be partial
     */
    parseAndUpdateState(data) {
        if (typeof data !== "object" || data === null) {
            return;
        }

        let statusRelevant = false;
        for (const key of ["work_mode", "status", "charge_state", "fault"]) {
            if (data[key] !== undefined) {
                this.ephemeralState[key] = data[key];
                statusRelevant = true;
            }
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
                `KaercherRCV5ValetudoRobot: DND-related fields in incoming data: ` +
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
// Defaults to the real on-device loopback-alias bind (see KaercherAiotDummycloud.BIND_IP's
// own comment) — only correct once Valetudo actually runs ON the robot. Dev-Mac test
// harnesses running Valetudo remotely need to override this to "0.0.0.0" instead, the
// same way contrib/karcher-rcv5/dev/run_dummycloud.js already does for
// KaercherAiotDummycloud directly.
KaercherRCV5ValetudoRobot.BIND_IP = KaercherAiotDummycloud.BIND_IP;

module.exports = KaercherRCV5ValetudoRobot;
