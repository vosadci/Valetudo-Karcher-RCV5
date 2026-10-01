const express = require("express");

const MAX_BACKLOG_BYTES = 1024 * 1024;

class KaercherCameraRouter {
    /**
     * @param {object} options
     * @param {import("./camera/KaercherCameraStream")} options.cameraStream
     * @param {() => boolean} options.isEnabled
     */
    constructor(options) {
        this.router = express.Router({mergeParams: true});
        this.cameraStream = options.cameraStream;
        this.isEnabled = options.isEnabled;

        this.initRoutes();
    }

    /**
     * @private
     */
    initRoutes() {
        this.router.get("/status", (req, res) => {
            res.json(Object.assign({enabled: this.isEnabled()}, this.cameraStream.getStatus()));
        });

        this.router.get("/stream", (req, res) => {
            if (!this.isEnabled()) {
                return res.status(403).json({message: "The camera is turned off"});
            }

            if (!this.cameraStream.canSubscribe()) {
                return res.sendStatus(503);
            }

            res.set({
                "Content-Type": "video/MP2T",
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no"
            });
            res.flushHeaders();

            const unsubscribe = this.cameraStream.subscribe({
                write: (buf) => {
                    if (res.destroyed || res.writableEnded) {
                        return;
                    }

                    if (res.writableLength > MAX_BACKLOG_BYTES) {
                        res.destroy();

                        return;
                    }

                    res.write(buf);
                },
                destroy: () => {
                    res.destroy();
                }
            });

            res.on("close", unsubscribe);
        });
    }

    getRouter() {
        return this.router;
    }
}

module.exports = KaercherCameraRouter;
