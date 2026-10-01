const PID_PMT = 0x1000;
const PID_VIDEO = 0x100;
const TS_PACKET_SIZE = 188;
const CLOCK_HZ = 90000;
const PTS_MODULO = 2 ** 33;
const RTP_MODULO = 2 ** 32;
// The first presentation time is one second in, so the PCR that leads it never goes negative
const START_OFFSET = CLOCK_HZ;
const PCR_LEAD = 9000;
const PES_HEADER_SIZE = 14;
const PCR_ADAPTATION_SIZE = 8;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);

    for (let i = 0; i < 256; i++) {
        let crc = i << 24;

        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
        }

        table[i] = crc >>> 0;
    }

    return table;
})();

/**
 * @param {Buffer} buf
 * @return {number}
 */
function crc32(buf) {
    let crc = 0xFFFFFFFF;

    for (const byte of buf) {
        crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xFF]) >>> 0;
    }

    return crc >>> 0;
}

/**
 * @param {number} tableId
 * @param {Buffer} body
 * @return {Buffer}
 */
function buildSection(tableId, body) {
    const length = 5 + body.length + 4;
    const section = Buffer.alloc(3 + length);

    section[0] = tableId;
    section[1] = 0xB0 | (length >> 8);
    section[2] = length & 0xFF;
    section.writeUInt16BE(1, 3);
    section[5] = 0xC1;
    body.copy(section, 8);
    section.writeUInt32BE(crc32(section.subarray(0, section.length - 4)), section.length - 4);

    return section;
}

const PAT_SECTION = buildSection(0x00, Buffer.from([0x00, 0x01, 0xE0 | (PID_PMT >> 8), PID_PMT & 0xFF]));
const PMT_SECTION = buildSection(0x02, Buffer.from([
    0xE0 | (PID_VIDEO >> 8), PID_VIDEO & 0xFF,
    0xF0, 0x00,
    0x1B, 0xE0 | (PID_VIDEO >> 8), PID_VIDEO & 0xFF, 0xF0, 0x00
]));

/**
 * Wraps H.264 access units into an MPEG-TS stream: one video PID, PTS taken straight from the 90 kHz RTP clock.
 * No B-frames are expected, so DTS equals PTS and is left out.
 */
class KaercherTsMuxer {
    constructor() {
        this.patCounter = 0;
        this.pmtCounter = 0;
        this.videoCounter = 0;

        this.rtpBase = null;
        this.lastRtp = 0;
        this.rtpWraps = 0;
    }

    /**
     * PAT and PMT. Players need them before a keyframe to find the video.
     *
     * @return {Buffer}
     */
    psi() {
        const out = Buffer.alloc(2 * TS_PACKET_SIZE, 0xFF);

        KaercherTsMuxer.writePsiPacket(out, 0, 0, PAT_SECTION, this.patCounter++);
        KaercherTsMuxer.writePsiPacket(out, TS_PACKET_SIZE, PID_PMT, PMT_SECTION, this.pmtCounter++);

        return out;
    }

    /**
     * @param {Buffer} annexB one access unit, NAL units with start codes
     * @param {number} rtpTimestamp
     * @param {boolean} isKeyframe
     * @return {Buffer}
     */
    mux(annexB, rtpTimestamp, isKeyframe) {
        const pts = this.extendTimestamp(rtpTimestamp) % PTS_MODULO;
        const pesSize = PES_HEADER_SIZE + annexB.length;
        const firstCapacity = 184 - PCR_ADAPTATION_SIZE;
        const packetCount = 1 + Math.ceil(Math.max(0, pesSize - firstCapacity) / 184);

        const pes = Buffer.allocUnsafe(pesSize);
        KaercherTsMuxer.writePesHeader(pes, pts);
        annexB.copy(pes, PES_HEADER_SIZE);

        const out = Buffer.alloc(packetCount * TS_PACKET_SIZE, 0xFF);
        let pesOffset = 0;

        for (let i = 0; i < packetCount; i++) {
            const first = i === 0;
            const base = i * TS_PACKET_SIZE;
            const capacity = first ? firstCapacity : 184;
            const size = Math.min(capacity, pesSize - pesOffset);
            const stuffing = capacity - size;
            const hasAdaptation = first || stuffing > 0;

            out[base] = 0x47;
            out[base + 1] = (first ? 0x40 : 0) | (PID_VIDEO >> 8);
            out[base + 2] = PID_VIDEO & 0xFF;
            out[base + 3] = (hasAdaptation ? 0x30 : 0x10) | (this.videoCounter++ & 0x0F);

            let payloadStart = base + 4;

            if (first) {
                out[base + 4] = 7 + stuffing;
                out[base + 5] = 0x10 | (isKeyframe ? 0x40 : 0);
                KaercherTsMuxer.writePcr(out, base + 6, pts - PCR_LEAD);
                payloadStart = base + 4 + 1 + 7 + stuffing;
            } else if (stuffing > 0) {
                out[base + 4] = stuffing - 1;

                if (stuffing > 1) {
                    out[base + 5] = 0;
                }

                payloadStart = base + 4 + stuffing;
            }

            pes.copy(out, payloadStart, pesOffset, pesOffset + size);
            pesOffset += size;
        }

        return out;
    }

    /**
     * @private
     * @param {number} rtpTimestamp
     * @return {number}
     */
    extendTimestamp(rtpTimestamp) {
        if (this.rtpBase === null) {
            this.rtpBase = rtpTimestamp;
            this.lastRtp = rtpTimestamp;
        }

        if (rtpTimestamp < this.lastRtp && this.lastRtp - rtpTimestamp > RTP_MODULO / 2) {
            this.rtpWraps++;
        }

        this.lastRtp = rtpTimestamp;

        return this.rtpWraps * RTP_MODULO + rtpTimestamp - this.rtpBase + START_OFFSET;
    }

    /**
     * @param {Buffer} out
     * @param {number} offset
     * @param {number} pid
     * @param {Buffer} section
     * @param {number} counter
     */
    static writePsiPacket(out, offset, pid, section, counter) {
        out[offset] = 0x47;
        out[offset + 1] = 0x40 | (pid >> 8);
        out[offset + 2] = pid & 0xFF;
        out[offset + 3] = 0x10 | (counter & 0x0F);
        out[offset + 4] = 0;
        section.copy(out, offset + 5);
    }

    /**
     * @param {Buffer} out
     * @param {number} pts
     */
    static writePesHeader(out, pts) {
        out.writeUInt32BE(0x000001E0, 0);
        out.writeUInt16BE(0, 4);
        out[6] = 0x80;
        out[7] = 0x80;
        out[8] = 5;
        out[9] = 0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1);
        out.writeUInt16BE((((Math.floor(pts / 2 ** 15)) & 0x7FFF) << 1) | 1, 10);
        out.writeUInt16BE(((pts & 0x7FFF) << 1) | 1, 12);
    }

    /**
     * @param {Buffer} out
     * @param {number} offset
     * @param {number} pcr 33 bit base in 90 kHz units
     */
    static writePcr(out, offset, pcr) {
        out[offset] = Math.floor(pcr / 2 ** 25) & 0xFF;
        out[offset + 1] = Math.floor(pcr / 2 ** 17) & 0xFF;
        out[offset + 2] = Math.floor(pcr / 2 ** 9) & 0xFF;
        out[offset + 3] = Math.floor(pcr / 2) & 0xFF;
        out[offset + 4] = ((pcr & 1) << 7) | 0x7E;
        out[offset + 5] = 0;
    }
}

KaercherTsMuxer.TS_PACKET_SIZE = TS_PACKET_SIZE;

module.exports = KaercherTsMuxer;
