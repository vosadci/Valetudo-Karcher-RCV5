const express = require("express");

const Logger = require("../../Logger");

class KaercherMapsRouter {
    /**
     * @param {object} options
     * @param {import("./KaercherRCV5ValetudoRobot")} options.robot
     */
    constructor(options) {
        this.router = express.Router({mergeParams: true});
        this.robot = options.robot;

        this.initRoutes();
    }

    /**
     * @private
     */
    initRoutes() {
        this.router.get("/", async (req, res) => {
            try {
                res.json(await this.robot.requestMapList());
            } catch (e) {
                Logger.warn("KaercherMapsRouter: failed to list maps", e);
                res.status(500).json({message: e.message});
            }
        });

        this.router.put("/:id/name", async (req, res) => {
            const id = Number(req.params.id);
            const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";

            if (!Number.isInteger(id) || name.length === 0 || name.length > KaercherMapsRouter.MAX_NAME_LENGTH) {
                return res.sendStatus(400);
            }

            try {
                res.json(await this.robot.renameMap(id, name));
            } catch (e) {
                Logger.warn("KaercherMapsRouter: failed to rename map", e);
                res.status(500).json({message: e.message});
            }
        });

        this.router.put("/:id/current", async (req, res) => {
            const id = Number(req.params.id);

            if (!Number.isInteger(id)) {
                return res.sendStatus(400);
            }

            try {
                res.json(await this.robot.selectMap(id));
            } catch (e) {
                Logger.warn("KaercherMapsRouter: failed to select map", e);
                res.status(500).json({message: e.message});
            }
        });

        this.router.delete("/:id", async (req, res) => {
            const id = Number(req.params.id);

            if (!Number.isInteger(id)) {
                return res.sendStatus(400);
            }

            try {
                const maps = await this.robot.requestMapList();

                if (maps.find(map => map.id === id)?.cur) {
                    return res.status(409).json({message: "Select another map before deleting the current one"});
                }

                res.json(await this.robot.deleteMap(id));
            } catch (e) {
                Logger.warn("KaercherMapsRouter: failed to delete map", e);
                res.status(500).json({message: e.message});
            }
        });
    }

    getRouter() {
        return this.router;
    }
}

KaercherMapsRouter.MAX_NAME_LENGTH = 24;

module.exports = KaercherMapsRouter;
