const START_CODE = Buffer.from([0, 0, 0, 1]);

const NAL_IDR = 5;
const NAL_AUD = 9;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_STAP_A = 24;
const NAL_FU_A = 28;

/**
 * Turns RTP packets (RFC 6184, single NAL, STAP-A and FU-A) into Annex B access units.
 * A unit that lost a packet is dropped whole, and the next unit that comes out is marked as a discontinuity.
 *
 * SPS and PPS are kept out of the units and handed over separately with each keyframe. Safari's
 * media pipeline refuses a stream that repeats them mid-stream, so each viewer gets them once, at the start.
 * Access unit delimiters are dropped for the same reason.
 */
class KaercherH264Depacketizer {
    /**
     * @param {(unit: {annexB: Buffer, rtpTimestamp: number, isKeyframe: boolean, discontinuity: boolean, parameterSets: Buffer|null}) => void} onAccessUnit
     */
    constructor(onAccessUnit) {
        this.onAccessUnit = onAccessUnit;

        this.sps = null;
        this.pps = null;
        this.nals = [];
        this.timestamp = null;
        this.fragments = null;
        this.lastSequence = null;
        this.broken = false;
        this.discontinuity = false;
        this.droppedUnits = 0;
    }

    /**
     * @param {Buffer} sps
     * @param {Buffer} pps
     */
    setParameterSets(sps, pps) {
        this.sps = sps;
        this.pps = pps;
    }

    /**
     * A malformed packet is dropped with its unit. It must never throw, because this runs inside a socket handler.
     *
     * @param {Buffer} packet one RTP packet
     */
    push(packet) {
        try {
            this.pushPacket(packet);
        } catch (e) {
            this.broken = true;
            this.fragments = null;
        }
    }

    /**
     * @private
     * @param {Buffer} packet
     */
    pushPacket(packet) {
        if (packet.length < 12) {
            return;
        }

        const marker = (packet[1] & 0x80) !== 0;
        const sequence = packet.readUInt16BE(2);
        const timestamp = packet.readUInt32BE(4);
        let offset = 12 + (packet[0] & 0x0F) * 4;
        let end = packet.length;

        if (packet[0] & 0x10) {
            offset += 4 + packet.readUInt16BE(offset + 2) * 4;
        }

        if (packet[0] & 0x20) {
            end -= packet[packet.length - 1];
        }

        if (offset > end) {
            this.broken = true;

            return;
        }

        const gap = this.lastSequence !== null && sequence !== ((this.lastSequence + 1) & 0xFFFF);

        if (gap) {
            this.broken = true;
            this.fragments = null;
        }
        this.lastSequence = sequence;

        if (this.timestamp !== null && timestamp !== this.timestamp) {
            this.flush();

            // The head of this new unit may be among the lost packets
            if (gap) {
                this.broken = true;
            }
        }
        this.timestamp = timestamp;

        this.addPayload(packet.subarray(offset, end));

        if (marker) {
            this.flush();
        }
    }

    /**
     * @private
     * @param {Buffer} payload
     */
    addPayload(payload) {
        if (payload.length === 0) {
            return;
        }

        const type = payload[0] & 0x1F;

        if (type >= 1 && type < NAL_STAP_A) {
            this.addNal(payload);
        } else if (type === NAL_STAP_A) {
            let offset = 1;

            while (offset + 2 <= payload.length) {
                const size = payload.readUInt16BE(offset);

                offset += 2;
                this.addNal(payload.subarray(offset, offset + size));
                offset += size;
            }
        } else if (type === NAL_FU_A && payload.length > 2) {
            const header = payload[1];

            if (header & 0x80) {
                this.fragments = [Buffer.from([(payload[0] & 0xE0) | (header & 0x1F)])];
            }

            if (this.fragments) {
                this.fragments.push(payload.subarray(2));

                if (header & 0x40) {
                    this.addNal(Buffer.concat(this.fragments));
                    this.fragments = null;
                }
            }
        }
    }

    /**
     * @private
     * @param {Buffer} nal
     */
    addNal(nal) {
        const type = nal[0] & 0x1F;

        if (type === NAL_SPS) {
            this.sps = Buffer.from(nal);
        } else if (type === NAL_PPS) {
            this.pps = Buffer.from(nal);
        }

        this.nals.push(nal);
    }

    /**
     * @private
     */
    flush() {
        const nals = this.nals;
        const timestamp = this.timestamp;

        this.nals = [];
        this.timestamp = null;

        if (this.broken) {
            this.broken = false;
            this.discontinuity = true;
            this.droppedUnits++;

            return;
        }

        if (nals.length === 0 || timestamp === null) {
            return;
        }

        const isKeyframe = nals.some(nal => {
            return (nal[0] & 0x1F) === NAL_IDR;
        });
        const parts = [];

        for (const nal of nals) {
            const type = nal[0] & 0x1F;

            if (type !== NAL_SPS && type !== NAL_PPS && type !== NAL_AUD) {
                parts.push(START_CODE, nal);
            }
        }

        if (parts.length === 0) {
            return;
        }

        const discontinuity = this.discontinuity;

        this.discontinuity = false;
        this.onAccessUnit({
            annexB: Buffer.concat(parts),
            rtpTimestamp: timestamp,
            isKeyframe: isKeyframe,
            discontinuity: discontinuity,
            parameterSets: isKeyframe && this.sps && this.pps ? Buffer.concat([START_CODE, this.sps, START_CODE, this.pps]) : null
        });
    }
}

module.exports = KaercherH264Depacketizer;
