const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherManualControlCapability = require("../../../../../lib/robots/karcher/capabilities/KaercherManualControlCapability");
const KaercherRCV5ValetudoRobot = require("../../../../../lib/robots/karcher/KaercherRCV5ValetudoRobot");
const ManualControlCapability = require("../../../../../lib/core/capabilities/ManualControlCapability");

const FAKE_CONFIG = {
    get: (key) => key === "embedded" ? false : undefined
};

function build(workMode) {
    const robot = new KaercherRCV5ValetudoRobot({config: FAKE_CONFIG, valetudoEventStore: {}});
    robot.ephemeralState.work_mode = workMode;

    const sent = [];
    robot.sendServiceInvoke = async (name, params) => {
        sent.push({name: name, params: params});
    };

    return {capability: new KaercherManualControlCapability({robot: robot}), sent: sent};
}

describe("KaercherManualControlCapability", () => {
    it("maps movement commands to set_direction values", async () => {
        const T = ManualControlCapability.MOVEMENT_COMMAND_TYPE;
        const {capability, sent} = build(undefined);

        for (const command of [T.FORWARD, T.ROTATE_COUNTERCLOCKWISE, T.ROTATE_CLOCKWISE, T.BACKWARD]) {
            await capability.manualControl(command);
        }

        assert.deepStrictEqual(sent.map(s => s.params.direction), [1, 2, 3, 4]);
        assert.ok(sent.every(s => s.name === "set_direction"));
    });

    it("rejects unknown movement commands", async () => {
        const {capability, sent} = build(undefined);

        await assert.rejects(capability.manualControl("sideways"));
        assert.strictEqual(sent.length, 0);
    });

    it("is active only in work_mode 2", async () => {
        assert.strictEqual(await build(2).capability.manualControlActive(), true);
        assert.strictEqual(await build(0).capability.manualControlActive(), false);
    });

    it("stays active after enable, before the robot moves", async () => {
        const {capability, sent} = build(0);

        await capability.enableManualControl();
        assert.strictEqual(await capability.manualControlActive(), true);

        await capability.disableManualControl();
        assert.strictEqual(await capability.manualControlActive(), false);
        assert.strictEqual(sent.length, 0);
    });

    it("disable sends a stop only while driving", async () => {
        const driving = build(2);
        await driving.capability.disableManualControl();
        assert.deepStrictEqual(driving.sent, [{
            name: "set_room_clean",
            params: {room_ids: [], ctrl_value: 0, clean_type: 0}
        }]);

        const idle = build(0);
        await idle.capability.disableManualControl();
        assert.strictEqual(idle.sent.length, 0);
    });
});
