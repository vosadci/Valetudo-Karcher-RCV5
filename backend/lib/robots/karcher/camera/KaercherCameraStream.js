const childProcess = require("child_process");
const {monitorEventLoopDelay} = require("perf_hooks");

const KaercherH264Depacketizer = require("./KaercherH264Depacketizer");
const KaercherRtspClient = require("./KaercherRtspClient");
const KaercherTsMuxer = require("./KaercherTsMuxer");
const Logger = require("../../../Logger");

const SOURCE_BINARY = "rkmedia_vi_venc_rtsp_test";
const SOURCE_ARGS = ["-d", "rkispp_scale1"];
const RTSP_PORT = 554;
const RTSP_PATH = "/live/main_stream";

const MAX_VIEWERS = 4;
const IDLE_STOP_MS = 10000;
const STARTUP_TIMEOUT_MS = 10000;
const CONNECT_RETRY_MS = 500;
const STALL_TIMEOUT_MS = 8000;
const FAILURE_COOLDOWN_MS = 5000;
const KILL_TIMEOUT_MS = 3000;
const EXIT_WAIT_MS = 5000;
const STALE_KILL_SETTLE_MS = 500;
const STATS_INTERVAL_MS = 10000;

/**
 * @param {number} ms
 * @return {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Serves the robot's camera as MPEG-TS. The hardware H.264 RTSP server only runs while someone watches:
 * the first viewer starts it, and it stops a short while after the last one leaves.
 * Nothing is buffered for late viewers. They get data from the next keyframe on.
 *
 * Every start and stop bumps a generation number. A start that finds the number changed after any wait
 * has been superseded and cleans up after itself instead of touching the shared state.
 */
class KaercherCameraStream {
    constructor() {
        /** @type {Set<{sink: {write: (buf: Buffer) => void, destroy: () => void}, muxer: KaercherTsMuxer, waitForKeyframe: boolean, resync: boolean}>} */
        this.viewers = new Set();

        /** @type {{process: import("child_process").ChildProcess, exited: Promise<void>, alive: boolean}|null} */
        this.source = null;
        /** @type {import("child_process").ChildProcess|null} */
        this.child = null;
        /** @type {KaercherRtspClient|null} */
        this.client = null;
        this.generation = 0;
        this.running = false;
        this.starting = false;
        this.stopped = Promise.resolve();
        this.idleTimer = null;
        this.stallTimer = null;
        this.failedAt = 0;
        this.lastDataAt = 0;

        this.loopDelay = monitorEventLoopDelay({resolution: 20});
        this.statsTimer = null;
        this.bytes = 0;
        this.lastCpu = process.cpuUsage();

        // Registered only while the camera process exists. A force exit skips shutdown(), and this is
        // the last chance to stop the process from keeping the camera and port 554 busy.
        this.onProcessExit = () => {
            this.child?.kill("SIGKILL");
        };
        this.onSignal = () => {
            this.destroyViewers();
            this.stop().catch(() => {
                /* intentional */
            });
        };
    }

    /**
     * @return {boolean}
     */
    canSubscribe() {
        return this.viewers.size < MAX_VIEWERS && Date.now() - this.failedAt > FAILURE_COOLDOWN_MS;
    }

    /**
     * @param {{write: (buf: Buffer) => void, destroy: () => void}} sink
     * @return {() => void} unsubscribe
     */
    subscribe(sink) {
        const viewer = {sink: sink, muxer: new KaercherTsMuxer(), waitForKeyframe: true, resync: false};

        this.viewers.add(viewer);
        clearTimeout(this.idleTimer);

        if (!this.running && !this.starting) {
            this.start();
        }

        return () => {
            this.viewers.delete(viewer);

            if (this.viewers.size === 0) {
                clearTimeout(this.idleTimer);
                this.idleTimer = setTimeout(() => {
                    if (!this.starting) {
                        this.stop();
                    }
                }, IDLE_STOP_MS);
            }
        };
    }

    /**
     * @return {{running: boolean, viewers: number}}
     */
    getStatus() {
        return {running: this.running, viewers: this.viewers.size};
    }

    async shutdown() {
        clearTimeout(this.idleTimer);
        this.destroyViewers();
        await this.stop();
    }

    /**
     * @private
     */
    async start() {
        const generation = ++this.generation;

        this.starting = true;

        try {
            await this.run(generation);
        } catch (e) {
            Logger.warn("KaercherCameraStream: could not start the camera stream", e);

            if (generation === this.generation) {
                this.fail();
            }
        }
    }

    /**
     * @private
     * @param {number} generation
     */
    async run(generation) {
        await this.stopped;

        if (generation !== this.generation) {
            return;
        }

        await this.killStaleSource();

        if (generation !== this.generation) {
            return;
        }

        this.spawnSource();

        const client = await this.connectWhenReady(generation);

        if (!client) {
            return;
        }

        const depacketizer = new KaercherH264Depacketizer((unit) => {
            this.lastDataAt = Date.now();
            this.deliver(unit);
        });

        if (client.sps && client.pps) {
            depacketizer.setParameterSets(client.sps, client.pps);
        }

        client.on("rtp", (packet) => {
            depacketizer.push(packet);
        });
        client.on("close", () => {
            if (this.client === client && this.running) {
                Logger.warn("KaercherCameraStream: RTSP connection closed");
                this.fail();
            }
        });

        this.client = client;
        this.running = true;
        this.starting = false;
        this.lastDataAt = Date.now();
        this.startMonitoring();

        if (this.viewers.size === 0) {
            this.stop();
        }
    }

    /**
     * A previous Valetudo that was killed outright can leave the camera process behind.
     *
     * @private
     * @return {Promise<void>}
     */
    async killStaleSource() {
        const killed = await new Promise((resolve) => {
            const killer = childProcess.spawn("killall", [SOURCE_BINARY], {stdio: "ignore"});

            killer.once("error", () => {
                resolve(false);
            });
            killer.once("exit", (code) => {
                resolve(code === 0);
            });
        });

        if (killed) {
            Logger.warn(`KaercherCameraStream: stopped a stale ${SOURCE_BINARY}`);
            await sleep(STALE_KILL_SETTLE_MS);
        }
    }

    /**
     * @private
     */
    spawnSource() {
        const child = childProcess.spawn(SOURCE_BINARY, SOURCE_ARGS, {stdio: "ignore"});
        const source = {process: child, alive: true, exited: Promise.resolve()};

        source.exited = new Promise((resolve) => {
            child.once("exit", (code, signal) => {
                Logger.debug(`KaercherCameraStream: ${SOURCE_BINARY} exited (code ${code}, signal ${signal})`);
                this.sourceEnded(source);
                resolve();
            });
            child.once("error", (e) => {
                Logger.warn(`KaercherCameraStream: could not run ${SOURCE_BINARY}`, e);
                this.sourceEnded(source);
                resolve();
            });
        });

        this.source = source;
        this.child = child;
        process.on("exit", this.onProcessExit);
        process.on("SIGTERM", this.onSignal);
        process.on("SIGINT", this.onSignal);
    }

    /**
     * @private
     * @param {{process: import("child_process").ChildProcess, alive: boolean}} source
     */
    sourceEnded(source) {
        source.alive = false;

        if (this.child === source.process) {
            this.child = null;
            process.removeListener("exit", this.onProcessExit);
            process.removeListener("SIGTERM", this.onSignal);
            process.removeListener("SIGINT", this.onSignal);
        }

        if (this.source === source && (this.running || this.starting)) {
            this.source = null;
            this.fail();
        }
    }

    /**
     * The RTSP server needs a moment after the binary starts, so try until it answers.
     *
     * @private
     * @param {number} generation
     * @return {Promise<KaercherRtspClient|null>} null when this start was superseded
     */
    async connectWhenReady(generation) {
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;

        for (;;) {
            const client = new KaercherRtspClient({host: "127.0.0.1", port: RTSP_PORT, path: RTSP_PATH});

            try {
                await client.start();
            } catch (e) {
                client.close();

                if (generation !== this.generation) {
                    return null;
                }

                if (Date.now() > deadline || !this.source?.alive) {
                    throw e;
                }

                await sleep(CONNECT_RETRY_MS);

                if (generation !== this.generation) {
                    return null;
                }

                continue;
            }

            if (generation !== this.generation) {
                client.close();

                return null;
            }

            return client;
        }
    }

    /**
     * Each viewer has its own muxer, so its packet counters and timestamps start fresh when it joins.
     *
     * @private
     * @param {{annexB: Buffer, rtpTimestamp: number, isKeyframe: boolean, discontinuity: boolean, parameterSets: Buffer|null}} unit
     */
    deliver(unit) {
        for (const viewer of this.viewers) {
            if (unit.discontinuity && !unit.isKeyframe) {
                viewer.resync = true;
            }

            if (!unit.isKeyframe && (viewer.waitForKeyframe || viewer.resync)) {
                continue;
            }

            if (viewer.waitForKeyframe && !unit.parameterSets) {
                continue;
            }

            const annexB = viewer.waitForKeyframe && unit.parameterSets ?
                Buffer.concat([unit.parameterSets, unit.annexB]) :
                unit.annexB;
            let chunk = viewer.muxer.mux(annexB, unit.rtpTimestamp, unit.isKeyframe);

            if (unit.isKeyframe) {
                chunk = Buffer.concat([viewer.muxer.psi(), chunk]);
            }

            viewer.waitForKeyframe = false;
            viewer.resync = false;
            this.bytes += chunk.length;
            viewer.sink.write(chunk);
        }
    }

    /**
     * @private
     */
    startMonitoring() {
        this.loopDelay.enable();
        this.lastCpu = process.cpuUsage();
        this.bytes = 0;

        this.stallTimer = setInterval(() => {
            if (Date.now() - this.lastDataAt > STALL_TIMEOUT_MS) {
                Logger.warn("KaercherCameraStream: no video for a while, giving up");
                this.fail();
            }
        }, 2000);

        this.statsTimer = setInterval(() => {
            const cpu = process.cpuUsage(this.lastCpu);
            const seconds = STATS_INTERVAL_MS / 1000;

            this.lastCpu = process.cpuUsage();
            Logger.debug(
                `KaercherCameraStream: viewers ${this.viewers.size}, ${Math.round(this.bytes * 8 / seconds / 1000)} kbit/s, ` +
                `valetudo cpu ${((cpu.user + cpu.system) / 1000 / STATS_INTERVAL_MS * 100).toFixed(1)}% of one core, ` +
                `event loop delay p99 ${(this.loopDelay.percentile(99) / 1e6).toFixed(1)} ms, max ${(this.loopDelay.max / 1e6).toFixed(1)} ms`
            );
            this.loopDelay.reset();
            this.bytes = 0;
        }, STATS_INTERVAL_MS);
    }

    /**
     * @private
     */
    fail() {
        this.failedAt = Date.now();
        this.destroyViewers();
        this.stop();
    }

    /**
     * @private
     */
    destroyViewers() {
        for (const viewer of this.viewers) {
            viewer.sink.destroy();
        }
        this.viewers.clear();
    }

    /**
     * Never rejects. The returned promise settles once the camera process is gone, or after a timeout if it won't die.
     *
     * @private
     * @return {Promise<void>}
     */
    stop() {
        this.generation++;
        this.running = false;
        this.starting = false;

        clearInterval(this.stallTimer);
        clearInterval(this.statsTimer);
        this.loopDelay.disable();

        const client = this.client;
        const source = this.source;

        this.client = null;
        this.source = null;
        client?.close();

        if (source?.alive) {
            const killTimer = setTimeout(() => {
                source.process.kill("SIGKILL");
            }, KILL_TIMEOUT_MS);

            source.process.kill("SIGTERM");
            this.stopped = Promise.race([source.exited, sleep(EXIT_WAIT_MS)]).then(() => {
                clearTimeout(killTimer);
            });
        }

        return this.stopped;
    }
}

module.exports = KaercherCameraStream;
