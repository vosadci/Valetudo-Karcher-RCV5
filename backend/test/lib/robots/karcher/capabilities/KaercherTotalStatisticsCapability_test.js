const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherTotalStatisticsCapability = require("../../../../../lib/robots/karcher/capabilities/KaercherTotalStatisticsCapability");
const ValetudoDataPoint = require("../../../../../lib/entities/core/ValetudoDataPoint");

describe("KaercherTotalStatisticsCapability", () => {
    describe("parseRecord", () => {
        it("parses a plain record object", () => {
            const record = KaercherTotalStatisticsCapability.parseRecord({
                record_start_time: 1700000000,
                record_use_time: 1800,
                record_clean_area: 2500,
                record_task_status: 1
            });

            assert.deepStrictEqual(record, {start: 1700000000, useTime: 1800, area: 2500});
        });

        it("parses a JSON-stringified record", () => {
            const record = KaercherTotalStatisticsCapability.parseRecord(JSON.stringify({
                record_start_time: 1700000000,
                record_use_time: 1800,
                record_clean_area: 2500
            }));

            assert.deepStrictEqual(record, {start: 1700000000, useTime: 1800, area: 2500});
        });

        it("parses a wrapped identifierValue string, mirroring the cloud REST shape", () => {
            const record = KaercherTotalStatisticsCapability.parseRecord({
                identifierValue: JSON.stringify({
                    record_start_time: 1700000000,
                    record_use_time: 1800,
                    record_clean_area: 2500
                })
            });

            assert.deepStrictEqual(record, {start: 1700000000, useTime: 1800, area: 2500});
        });

        it("returns null for missing fields", () => {
            assert.strictEqual(KaercherTotalStatisticsCapability.parseRecord({record_start_time: 1700000000}), null);
        });

        it("returns null for unparseable JSON", () => {
            assert.strictEqual(KaercherTotalStatisticsCapability.parseRecord("not json"), null);
        });

        it("returns null for non-object input", () => {
            assert.strictEqual(KaercherTotalStatisticsCapability.parseRecord(42), null);
            assert.strictEqual(KaercherTotalStatisticsCapability.parseRecord(null), null);
        });
    });

    describe("sumRecords", () => {
        it("sums useTime (seconds) and area (0.01 m² -> cm²), counts records", () => {
            const records = {
                "1700000000": {start: 1700000000, useTime: 600, area: 1000},
                "1700003600": {start: 1700003600, useTime: 1200, area: 2500}
            };

            assert.deepStrictEqual(KaercherTotalStatisticsCapability.sumRecords(records), {
                time: 1800,
                area: 350000,
                count: 2
            });
        });

        it("returns zeroes for no records", () => {
            assert.deepStrictEqual(KaercherTotalStatisticsCapability.sumRecords({}), {
                time: 0,
                area: 0,
                count: 0
            });
        });
    });

    describe("instance behaviour", () => {
        function buildCapability() {
            const capability = Object.create(KaercherTotalStatisticsCapability.prototype);
            capability.records = {};
            // Avoid touching the real filesystem — saveRecords() is only exercised
            // for its dedupe-by-key effect on this.records here, not persistence.
            capability.saveRecords = () => {};
            return capability;
        }

        it("handleCleanRecordEvent stores a valid record keyed by start time", () => {
            const capability = buildCapability();

            capability.handleCleanRecordEvent({
                record_start_time: 1700000000,
                record_use_time: 600,
                record_clean_area: 1000
            });

            assert.deepStrictEqual(capability.records, {
                "1700000000": {start: 1700000000, useTime: 600, area: 1000}
            });
        });

        it("handleCleanRecordEvent overwrites on a resend with the same start time", () => {
            const capability = buildCapability();

            capability.handleCleanRecordEvent({record_start_time: 1700000000, record_use_time: 600, record_clean_area: 1000});
            capability.handleCleanRecordEvent({record_start_time: 1700000000, record_use_time: 900, record_clean_area: 1500});

            assert.deepStrictEqual(capability.records, {
                "1700000000": {start: 1700000000, useTime: 900, area: 1500}
            });
        });

        it("handleCleanRecordEvent ignores an unparseable event", () => {
            const capability = buildCapability();

            capability.handleCleanRecordEvent({garbage: true});

            assert.deepStrictEqual(capability.records, {});
        });

        it("getStatistics reflects stored records", async () => {
            const capability = buildCapability();
            capability.records = {
                "1700000000": {start: 1700000000, useTime: 600, area: 1000}
            };

            const statistics = await capability.getStatistics();

            assert.deepStrictEqual(statistics.map(dp => ({type: dp.type, value: dp.value})), [
                {type: ValetudoDataPoint.TYPES.TIME, value: 600},
                {type: ValetudoDataPoint.TYPES.AREA, value: 100000},
                {type: ValetudoDataPoint.TYPES.COUNT, value: 1}
            ]);
        });

        it("getProperties reports TIME, AREA and COUNT as available", () => {
            const capability = buildCapability();

            assert.deepStrictEqual(capability.getProperties(), {
                availableStatistics: [
                    ValetudoDataPoint.TYPES.TIME,
                    ValetudoDataPoint.TYPES.AREA,
                    ValetudoDataPoint.TYPES.COUNT
                ]
            });
        });
    });
});
