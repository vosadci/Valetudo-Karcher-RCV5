const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherRCV5ValetudoRobot = require("../../../../lib/robots/karcher/KaercherRCV5ValetudoRobot");

const FAKE_CONFIG = {
    get: (key) => key === "embedded" ? false : undefined
};

function buildRobot() {
    const robot = new KaercherRCV5ValetudoRobot({config: FAKE_CONFIG, valetudoEventStore: {}});
    const requests = [];

    robot.sendPropertyGet = async () => {
        requests.push(Date.now());
    };

    return {robot: robot, requests: requests};
}

describe("KaercherRCV5ValetudoRobot property snapshot", () => {
    it("ignores the zeroed post-boot reply and asks again", (t) => {
        t.mock.timers.enable({apis: ["setTimeout"]});
        const {robot, requests} = buildRobot();

        robot.handlePropertySnapshot({status: -1, quantity: 0, map_num: 0});

        assert.strictEqual(robot.ephemeralState.quantity, undefined);
        t.mock.timers.tick(KaercherRCV5ValetudoRobot.SNAPSHOT_RETRY_MS);
        assert.strictEqual(requests.length, 1);
    });

    it("applies a real reply", () => {
        const {robot} = buildRobot();

        robot.handlePropertySnapshot({status: 4, quantity: 100, charge_state: 1});

        assert.strictEqual(robot.ephemeralState.quantity, 100);
    });

    it("gives up after the retry limit", (t) => {
        t.mock.timers.enable({apis: ["setTimeout"]});
        const {robot, requests} = buildRobot();

        for (let i = 0; i < KaercherRCV5ValetudoRobot.SNAPSHOT_MAX_RETRIES + 3; i++) {
            robot.handlePropertySnapshot({status: -1});
            t.mock.timers.tick(KaercherRCV5ValetudoRobot.SNAPSHOT_RETRY_MS);
        }

        assert.strictEqual(requests.length, KaercherRCV5ValetudoRobot.SNAPSHOT_MAX_RETRIES);
    });
});
