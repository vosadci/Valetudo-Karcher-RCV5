const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherTsMuxer = require("../../../../../lib/robots/karcher/camera/KaercherTsMuxer");

const PACKET = 188;

function pidOf(buf, packet) {
    return ((buf[packet * PACKET + 1] & 0x1F) << 8) | buf[packet * PACKET + 2];
}

describe("KaercherTsMuxer", () => {
    it("emits whole, sync-aligned packets for any payload size", () => {
        const muxer = new KaercherTsMuxer();

        for (const size of [1, 100, 167, 168, 169, 176, 177, 360, 361, 5000]) {
            const out = muxer.mux(Buffer.alloc(size, 0xAB), 3600, false);

            assert.strictEqual(out.length % PACKET, 0, `size ${size}`);

            for (let i = 0; i < out.length / PACKET; i++) {
                assert.strictEqual(out[i * PACKET], 0x47, `size ${size} packet ${i}`);
            }
        }
    });

    it("starts a PES with PCR on the first packet and the payload intact", () => {
        const muxer = new KaercherTsMuxer();
        const payload = Buffer.from(Array.from({length: 700}, (_, i) => i % 251));
        const out = muxer.mux(payload, 90000, true);

        assert.strictEqual(out[1] & 0x40, 0x40);
        assert.strictEqual(pidOf(out, 0), 0x100);
        assert.strictEqual(out[5] & 0x50, 0x50, "PCR and random access flags");

        const es = [];

        for (let i = 0; i < out.length / PACKET; i++) {
            const packet = out.subarray(i * PACKET, (i + 1) * PACKET);
            let offset = 4;

            if (packet[3] & 0x20) {
                offset += 1 + packet[4];
            }
            es.push(packet.subarray(offset));
        }

        const pes = Buffer.concat(es);

        assert.deepStrictEqual(pes.subarray(0, 4), Buffer.from([0, 0, 1, 0xE0]));
        assert.deepStrictEqual(pes.subarray(14), payload);
    });

    it("counts video packets continuously", () => {
        const muxer = new KaercherTsMuxer();
        const out = Buffer.concat([muxer.mux(Buffer.alloc(1000), 0, true), muxer.mux(Buffer.alloc(1000), 3000, false)]);

        for (let i = 0; i < out.length / PACKET; i++) {
            assert.strictEqual(out[i * PACKET + 3] & 0x0F, i & 0x0F);
        }
    });

    it("writes PAT then PMT with valid section lengths", () => {
        const psi = new KaercherTsMuxer().psi();

        assert.strictEqual(psi.length, 2 * PACKET);
        assert.strictEqual(pidOf(psi, 0), 0);
        assert.strictEqual(pidOf(psi, 1), 0x1000);
        assert.strictEqual(psi[5], 0x00);
        assert.strictEqual(psi[PACKET + 5], 0x02);
    });

    it("encodes the first PTS as one second and survives an RTP wrap", () => {
        const muxer = new KaercherTsMuxer();
        const first = muxer.mux(Buffer.alloc(10), 4294960000, true);
        const wrapped = muxer.mux(Buffer.alloc(10), 3000, false);

        const pts = (packet) => {
            const base = 4 + 1 + packet[4];
            const h = packet.subarray(base + 9, base + 14);

            return ((h[0] >> 1) & 7) * 2 ** 30 + ((h[1] << 8 | h[2]) >> 1) * 2 ** 15 + ((h[3] << 8 | h[4]) >> 1);
        };

        assert.strictEqual(pts(first), 90000);
        assert.strictEqual(pts(wrapped), 90000 + 3000 + (2 ** 32 - 4294960000));
    });
});
