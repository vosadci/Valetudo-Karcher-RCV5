const fs = require("fs");
const path = require("path");

const Logger = require("../../../Logger");
const TotalStatisticsCapability = require("../../../core/capabilities/TotalStatisticsCapability");
const ValetudoDataPoint = require("../../../entities/core/ValetudoDataPoint");

/**
 * The Kärcher app's own "total" statistics (CleanRecordActivity, decompiled APK
 * v1.4.32) are NOT a lifetime counter kept on the robot — they're a rolling 30-day
 * sum computed client-side from records the cloud REST API returns
 * (CleanRecordVM.getCleanRecordList(), beginTime = now-30d). That cloud history is
 * unreachable here, so this capability cannot reproduce the app's own numbers or
 * back-fill anything from before Valetudo started listening.
 *
 * What IS reachable: the robot pushes an unprompted MQTT event after each clean —
 * topic `thing/event/clean_record/post`, method `event.clean_record.post`
 * (confirmed via RobotApp binary strings: `event.%s.post`, `serializeCleanRecordEvent`,
 * `DEVICE_CLEAN_RECORD_ADD` — the wire fields below match the APK's Record.java
 * field-name mapping exactly). This capability persists every such record it
 * sees (keyed by record_start_time, so a resend just overwrites rather than
 * double-counts) and sums them on read — a real, growing lifetime total from the
 * point Valetudo took over, just not one that matches the app's rolling window or
 * includes pre-Valetudo history.
 *
 * Units are inferred from the app's own display code, not yet independently
 * confirmed live: record_use_time / 3600 -> hours (so seconds), record_clean_area /
 * 100 -> m² (so 0.01 m² units, matching KaercherCurrentStatisticsCapability's
 * cleaning_area convention). Raw per-record values are stored rather than a running
 * total specifically so a unit correction later just needs a re-sum, not a data
 * migration.
 *
 * @extends TotalStatisticsCapability<import("../KaercherRCV5ValetudoRobot")>
 */
class KaercherTotalStatisticsCapability extends TotalStatisticsCapability {
    constructor(options) {
        super(options);

        this.records = this.loadRecords();
    }

    /**
     * @return {Promise<Array<ValetudoDataPoint>>}
     */
    async getStatistics() {
        const {time, area, count} = KaercherTotalStatisticsCapability.sumRecords(this.records);

        return [
            new ValetudoDataPoint({type: ValetudoDataPoint.TYPES.TIME, value: time}),
            new ValetudoDataPoint({type: ValetudoDataPoint.TYPES.AREA, value: area}),
            new ValetudoDataPoint({type: ValetudoDataPoint.TYPES.COUNT, value: count})
        ];
    }

    getProperties() {
        return {
            availableStatistics: [
                ValetudoDataPoint.TYPES.TIME,
                ValetudoDataPoint.TYPES.AREA,
                ValetudoDataPoint.TYPES.COUNT
            ]
        };
    }

    /**
     * Called by KaercherRCV5ValetudoRobot whenever an event.clean_record.post
     * envelope arrives. `rawParams` shape isn't live-confirmed yet — handles it
     * being either the record object directly or a JSON-stringified blob (the
     * cloud REST equivalent, RecordBean.identifierValue, is the latter).
     *
     * @param {unknown} rawParams
     */
    handleCleanRecordEvent(rawParams) {
        const record = KaercherTotalStatisticsCapability.parseRecord(rawParams);

        if (!record) {
            Logger.warn(
                `KaercherTotalStatisticsCapability: received an unparseable clean_record event: ${JSON.stringify(rawParams)}`
            );
            return;
        }

        this.records[String(record.start)] = record;
        this.saveRecords();
    }

    /**
     * @private
     * @return {Object<string, {start: number, useTime: number, area: number}>}
     */
    loadRecords() {
        try {
            return JSON.parse(fs.readFileSync(KaercherTotalStatisticsCapability.RECORDS_PATH, "utf8"));
        } catch (e) {
            if (e.code !== "ENOENT") {
                Logger.warn("KaercherTotalStatisticsCapability: failed to load persisted clean records", e);
            }
            return {};
        }
    }

    /**
     * @private
     */
    saveRecords() {
        try {
            fs.mkdirSync(path.dirname(KaercherTotalStatisticsCapability.RECORDS_PATH), {recursive: true});
            fs.writeFileSync(KaercherTotalStatisticsCapability.RECORDS_PATH, JSON.stringify(this.records));
        } catch (e) {
            Logger.warn("KaercherTotalStatisticsCapability: failed to persist clean records", e);
        }
    }

    /**
     * @param {unknown} rawParams
     * @return {{start: number, useTime: number, area: number}|null}
     */
    static parseRecord(rawParams) {
        let data = rawParams;

        if (typeof data === "string") {
            try {
                data = JSON.parse(data);
            } catch (e) {
                return null;
            }
        }

        if (data && typeof data === "object" && typeof data.identifierValue === "string") {
            try {
                data = JSON.parse(data.identifierValue);
            } catch (e) {
                return null;
            }
        }

        if (!data || typeof data !== "object") {
            return null;
        }

        const start = Number(data.record_start_time);
        const useTime = Number(data.record_use_time);
        const area = Number(data.record_clean_area);

        if (!Number.isFinite(start) || !Number.isFinite(useTime) || !Number.isFinite(area)) {
            return null;
        }

        return {start: start, useTime: useTime, area: area};
    }

    /**
     * @param {Object<string, {start: number, useTime: number, area: number}>} records
     * @return {{time: number, area: number, count: number}}
     */
    static sumRecords(records) {
        const values = Object.values(records);

        return {
            time: values.reduce((sum, r) => sum + r.useTime, 0), // seconds
            area: values.reduce((sum, r) => sum + r.area, 0) * 100, // 0.01 m² units -> cm²
            count: values.length
        };
    }
}

KaercherTotalStatisticsCapability.RECORDS_PATH = "/userdata/valetudo/clean_records.json";

module.exports = KaercherTotalStatisticsCapability;
