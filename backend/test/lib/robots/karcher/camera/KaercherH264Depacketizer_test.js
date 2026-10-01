const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherH264Depacketizer = require("../../../../../lib/robots/karcher/camera/KaercherH264Depacketizer");

function rtp(sequence, timestamp, marker, payload) {
    const header = Buffer.alloc(12);

    header[0] = 0x80;
    header[1] = (marker ? 0x80 : 0) | 96;
    header.writeUInt16BE(sequence, 2);
    header.writeUInt32BE(timestamp, 4);

    return Buffer.concat([header, payload]);
}

const SPS = Buffer.from([0x67, 1, 2, 3]);
const PPS = Buffer.from([0x68, 4, 5]);
const START = [0, 0, 0, 1];

function collect() {
    const units = [];

    return {units: units, depacketizer: new KaercherH264Depacketizer((unit) => {
        units.push(unit);
    })};
}

describe("KaercherH264Depacketizer", () => {
    it("emits one unit per marker with Annex B framing", () => {
        const {units, depacketizer} = collect();
        const slice = Buffer.from([0x41, 9, 9, 9]);

        depacketizer.push(rtp(1, 1000, true, slice));

        assert.strictEqual(units.length, 1);
        assert.strictEqual(units[0].isKeyframe, false);
        assert.strictEqual(units[0].rtpTimestamp, 1000);
        assert.deepStrictEqual(units[0].annexB, Buffer.concat([Buffer.from(START), slice]));
        assert.strictEqual(units[0].parameterSets, null);
    });

    it("reassembles fragmented NAL units", () => {
        const {units, depacketizer} = collect();
        const idr = Buffer.from([0x65, 1, 2, 3, 4, 5, 6]);

        depacketizer.push(rtp(1, 1000, false, Buffer.concat([Buffer.from([0x7C, 0x85]), idr.subarray(1, 3)])));
        depacketizer.push(rtp(2, 1000, false, Buffer.concat([Buffer.from([0x7C, 0x05]), idr.subarray(3, 5)])));
        depacketizer.push(rtp(3, 1000, true, Buffer.concat([Buffer.from([0x7C, 0x45]), idr.subarray(5)])));

        assert.strictEqual(units.length, 1);
        assert.strictEqual(units[0].isKeyframe, true);
        assert.ok(units[0].annexB.includes(idr));
    });

    it("keeps the parameter sets out of the unit and hands them over with keyframes", () => {
        const {units, depacketizer} = collect();
        const stap = Buffer.concat([Buffer.from([0x78, 0, SPS.length]), SPS, Buffer.from([0, PPS.length]), PPS]);
        const idr = Buffer.from([0x65, 7, 7]);

        depacketizer.push(rtp(1, 1000, false, stap));
        depacketizer.push(rtp(2, 1000, true, idr));
        depacketizer.push(rtp(3, 2000, true, Buffer.from([0x41, 7, 7])));

        assert.deepStrictEqual(units[0].annexB, Buffer.concat([Buffer.from(START), idr]));
        assert.deepStrictEqual(units[0].parameterSets, Buffer.concat([Buffer.from(START), SPS, Buffer.from(START), PPS]));
        assert.strictEqual(units[1].parameterSets, null);
    });

    it("drops access unit delimiters", () => {
        const {units, depacketizer} = collect();
        const slice = Buffer.from([0x41, 9, 9]);

        depacketizer.push(rtp(1, 1000, false, Buffer.from([0x09, 0xF0])));
        depacketizer.push(rtp(2, 1000, true, slice));

        assert.deepStrictEqual(units[0].annexB, Buffer.concat([Buffer.from(START), slice]));
    });

    it("uses parameter sets from the stream description when the stream has none", () => {
        const {units, depacketizer} = collect();

        depacketizer.setParameterSets(SPS, PPS);
        depacketizer.push(rtp(1, 1000, true, Buffer.from([0x65, 7, 7])));

        assert.ok(units[0].parameterSets?.includes(SPS));
        assert.ok(units[0].parameterSets?.includes(PPS));
        assert.ok(!units[0].annexB.includes(SPS));
    });

    it("drops a unit after a lost packet and recovers on the next one", () => {
        const {units, depacketizer} = collect();

        depacketizer.push(rtp(1, 1000, false, Buffer.concat([Buffer.from([0x7C, 0x85]), Buffer.from([1, 2])])));
        depacketizer.push(rtp(3, 1000, true, Buffer.concat([Buffer.from([0x7C, 0x45]), Buffer.from([3, 4])])));
        depacketizer.push(rtp(4, 2000, true, Buffer.from([0x41, 1])));

        assert.strictEqual(units.length, 1);
        assert.strictEqual(units[0].rtpTimestamp, 2000);
        assert.strictEqual(depacketizer.droppedUnits, 1);
    });

    it("does not throw on a truncated extension header and drops that unit", () => {
        const {units, depacketizer} = collect();
        const bad = Buffer.alloc(14);

        bad[0] = 0x90;
        bad[1] = 0xE0;
        bad.writeUInt16BE(1, 2);

        assert.doesNotThrow(() => {
            depacketizer.push(bad);
        });
        assert.strictEqual(units.length, 0);
    });

    it("ignores RTP padding", () => {
        const {units, depacketizer} = collect();
        const slice = Buffer.from([0x41, 5, 5]);
        const packet = rtp(1, 1000, true, Buffer.concat([slice, Buffer.from([0, 0, 3])]));

        packet[0] |= 0x20;
        depacketizer.push(packet);

        assert.deepStrictEqual(units[0].annexB, Buffer.concat([Buffer.from(START), slice]));
    });

    it("does not send a headless unit when packets are lost across a unit boundary", () => {
        const {units, depacketizer} = collect();

        depacketizer.push(rtp(1, 1000, false, Buffer.concat([Buffer.from([0x7C, 0x85]), Buffer.from([1, 2])])));
        depacketizer.push(rtp(4, 4000, true, Buffer.from([0x41, 1])));
        depacketizer.push(rtp(5, 5000, true, Buffer.from([0x41, 2])));

        assert.strictEqual(units.length, 1);
        assert.strictEqual(units[0].rtpTimestamp, 5000);
        assert.strictEqual(units[0].discontinuity, true);
        assert.strictEqual(depacketizer.droppedUnits, 2);
    });
});
