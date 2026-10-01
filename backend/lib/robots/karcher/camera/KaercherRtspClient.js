const EventEmitter = require("events");
const net = require("net");

const Logger = require("../../../Logger");

const RESPONSE_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_SESSION_TIMEOUT_S = 60;
const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * A minimal RTSP client: one H.264 video track, RTP interleaved on the TCP connection.
 * Emits "rtp" with each packet and "close" once when the connection ends.
 */
class KaercherRtspClient extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.host
     * @param {number} options.port
     * @param {string} options.path
     */
    constructor(options) {
        super();

        this.host = options.host;
        this.port = options.port;
        this.url = `rtsp://${options.host}:${options.port}${options.path}`;

        /** @type {Buffer|null} */
        this.sps = null;
        /** @type {Buffer|null} */
        this.pps = null;

        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.pending = null;
        this.sequence = 1;
        this.session = null;
        this.keepAlive = null;
        this.closed = false;
    }

    /**
     * Resolves once the server is playing.
     *
     * @return {Promise<void>}
     */
    async start() {
        await this.connect();

        await this.request("OPTIONS", this.url);
        const describe = await this.request("DESCRIBE", this.url, {Accept: "application/sdp"});
        const trackUrl = this.parseSdp(describe.body);

        const setup = await this.request("SETUP", trackUrl, {Transport: "RTP/AVP/TCP;unicast;interleaved=0-1"});
        const session = /session:\s*([^;\r\n]+)(?:;timeout=(\d+))?/i.exec(setup.head);

        if (!session) {
            throw new Error("RTSP SETUP reply has no session");
        }
        this.session = session[1].trim();

        await this.request("PLAY", this.url, {Range: "npt=0.000-"});

        const timeoutS = Number(session[2] ?? DEFAULT_SESSION_TIMEOUT_S);
        this.keepAlive = setInterval(() => {
            this.request("OPTIONS", this.url).catch(() => {
                this.close();
            });
        }, Math.max(5, timeoutS / 2) * 1000);
    }

    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;

        clearInterval(this.keepAlive);
        this.socket?.destroy();
        this.pending?.reject(new Error("RTSP connection closed"));
        this.pending = null;
        this.emit("close");
    }

    /**
     * @private
     * @return {Promise<void>}
     */
    connect() {
        return new Promise((resolve, reject) => {
            const socket = net.connect(this.port, this.host);
            const timer = setTimeout(() => {
                socket.destroy(new Error("RTSP connect timed out"));
            }, CONNECT_TIMEOUT_MS);

            this.socket = socket;

            socket.once("connect", () => {
                clearTimeout(timer);
                socket.setNoDelay(true);
                resolve();
            });
            socket.on("data", (chunk) => {
                this.buffer = Buffer.concat([this.buffer, chunk]);
                this.parse();
            });
            socket.on("error", (e) => {
                clearTimeout(timer);
                reject(e);
                this.close();
            });
            socket.on("close", () => {
                this.close();
            });
        });
    }

    /**
     * @private
     * @param {string} method
     * @param {string} target
     * @param {Object<string, string>} [headers]
     * @return {Promise<{head: string, body: string}>}
     */
    request(method, target, headers = {}) {
        return new Promise((resolve, reject) => {
            let message = `${method} ${target} RTSP/1.0\r\nCSeq: ${this.sequence++}\r\n`;

            if (this.session) {
                message += `Session: ${this.session}\r\n`;
            }

            for (const [key, value] of Object.entries(headers)) {
                message += `${key}: ${value}\r\n`;
            }

            const timer = setTimeout(() => {
                this.pending = null;
                reject(new Error(`RTSP ${method} timed out`));
            }, RESPONSE_TIMEOUT_MS);

            this.pending = {
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
                resolve: (response) => {
                    clearTimeout(timer);

                    if (!/^RTSP\/1\.0 200/.test(response.head)) {
                        return reject(new Error(`RTSP ${method} failed: ${response.head.split("\r\n")[0]}`));
                    }

                    resolve(response);
                }
            };
            this.socket.write(message + "\r\n");
        });
    }

    /**
     * @private
     * @param {string} sdp
     * @return {string} control URL of the video track
     */
    parseSdp(sdp) {
        const video = sdp.split(/^m=/m).find(section => {
            return section.startsWith("video");
        });

        if (!video) {
            throw new Error("RTSP stream has no video track");
        }

        const parameterSets = /sprop-parameter-sets=([^;\s]+)/.exec(video);

        if (parameterSets) {
            const [sps, pps] = parameterSets[1].split(",").map(value => {
                return Buffer.from(value, "base64");
            });

            this.sps = sps;
            this.pps = pps;
        }

        const control = /a=control:(\S+)/.exec(video);

        if (!control) {
            return this.url;
        }

        return control[1].startsWith("rtsp://") ? control[1] : `${this.url.replace(/\/$/, "")}/${control[1]}`;
    }

    /**
     * @private
     */
    parse() {
        while (this.buffer.length > 0) {
            if (this.buffer[0] === 0x24) {
                if (this.buffer.length < 4) {
                    return;
                }

                const length = this.buffer.readUInt16BE(2);

                if (this.buffer.length < 4 + length) {
                    return;
                }

                if (this.buffer[1] === 0) {
                    this.emit("rtp", this.buffer.subarray(4, 4 + length));
                }
                this.buffer = this.buffer.subarray(4 + length);
            } else {
                const prefix = this.buffer.subarray(0, 5).toString("latin1");

                if (!"RTSP/".startsWith(prefix) && !prefix.startsWith("RTSP/")) {
                    Logger.warn("KaercherRtspClient: unexpected data from the RTSP server, closing");
                    this.close();

                    return;
                }

                const end = this.buffer.indexOf("\r\n\r\n");

                if (end < 0) {
                    if (this.buffer.length > MAX_BUFFER_BYTES) {
                        Logger.warn("KaercherRtspClient: RTSP reply is too large, closing");
                        this.close();
                    }

                    return;
                }

                const head = this.buffer.subarray(0, end).toString();
                const bodyLength = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);

                if (this.buffer.length < end + 4 + bodyLength) {
                    return;
                }

                const body = this.buffer.subarray(end + 4, end + 4 + bodyLength).toString();

                this.buffer = this.buffer.subarray(end + 4 + bodyLength);

                const pending = this.pending;
                this.pending = null;
                pending?.resolve({head: head, body: body});
            }
        }
    }
}

module.exports = KaercherRtspClient;
