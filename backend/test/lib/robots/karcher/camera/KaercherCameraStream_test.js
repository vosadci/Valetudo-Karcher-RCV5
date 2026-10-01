const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherCameraStream = require("../../../../../lib/robots/karcher/camera/KaercherCameraStream");
const KaercherTsMuxer = require("../../../../../lib/robots/karcher/camera/KaercherTsMuxer");

const SPS_PPS = Buffer.from([0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2]);

function unit(timestamp, isKeyframe, extra = {}) {
    return Object.assign({
        annexB: Buffer.from([0, 0, 0, 1, isKeyframe ? 0x65 : 0x41, 9, 9]),
        rtpTimestamp: timestamp,
        isKeyframe: isKeyframe,
        discontinuity: false,
        parameterSets: isKeyframe ? SPS_PPS : null
    }, extra);
}

function setup() {
    const chunks = [];
    const viewer = {
        sink: {write: (buf) => chunks.push(buf), destroy: () => {}},
        muxer: new KaercherTsMuxer(),
        waitForKeyframe: true,
        resync: false
    };
    const stream = {viewers: new Set([viewer]), bytes: 0};
    const deliver = (u) => KaercherCameraStream.prototype.deliver.call(stream, u);

    return {chunks: chunks, viewer: viewer, deliver: deliver};
}

describe("KaercherCameraStream delivery", () => {
    it("holds a new viewer back until a keyframe and sends the parameter sets once", () => {
        const {chunks, deliver} = setup();

        deliver(unit(1000, false));
        assert.strictEqual(chunks.length, 0);

        deliver(unit(2000, true));
        deliver(unit(3000, false));
        deliver(unit(4000, true));

        assert.strictEqual(chunks.length, 3);
        assert.ok(chunks[0].includes(Buffer.from([0x67, 1])));
        assert.ok(!chunks[2].includes(Buffer.from([0x67, 1])));
    });

    it("keeps waiting when a keyframe arrives without parameter sets", () => {
        const {chunks, deliver} = setup();

        deliver(unit(1000, true, {parameterSets: null}));
        assert.strictEqual(chunks.length, 0);

        deliver(unit(2000, true));
        assert.strictEqual(chunks.length, 1);
    });

    it("skips to the next keyframe after a discontinuity without resending the parameter sets", () => {
        const {chunks, deliver} = setup();

        deliver(unit(1000, true));
        deliver(unit(2000, false));
        deliver(unit(3000, false, {discontinuity: true}));
        deliver(unit(4000, false));
        assert.strictEqual(chunks.length, 2);

        deliver(unit(5000, true));
        assert.strictEqual(chunks.length, 3);
        assert.ok(!chunks[2].includes(Buffer.from([0x67, 1])));

        deliver(unit(6000, false));
        assert.strictEqual(chunks.length, 4);
    });
});
