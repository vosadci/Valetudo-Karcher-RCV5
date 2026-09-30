const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherBasicControlCapability = require("../../../../../lib/robots/karcher/capabilities/KaercherBasicControlCapability");
const KaercherRCV5ValetudoRobot = require("../../../../../lib/robots/karcher/KaercherRCV5ValetudoRobot");
const ValetudoMapSegment = require("../../../../../lib/entities/core/ValetudoMapSegment");

const FAKE_CONFIG = {
    get: (key) => key === "embedded" ? false : undefined
};

function buildRobot(workMode) {
    const robot = new KaercherRCV5ValetudoRobot({config: FAKE_CONFIG, valetudoEventStore: {}});

    robot.ephemeralState.work_mode = workMode;
    robot.state.map = {
        getSegments: () => [new ValetudoMapSegment({id: "1"}), new ValetudoMapSegment({id: "2"})]
    };

    const sent = [];
    robot.sendServiceInvoke = async (name, params) => {
        sent.push({name: name, params: params});
    };

    return {robot: robot, sent: sent};
}

describe("KaercherBasicControlCapability", () => {
    describe("while idle (no zone clean active)", () => {
        it("start() sends a full-house set_room_clean", async () => {
            const {robot, sent} = buildRobot(undefined);
            await new KaercherBasicControlCapability({robot: robot}).start();

            assert.strictEqual(sent[0].name, "set_room_clean");
            assert.deepStrictEqual(sent[0].params, {room_ids: [1, 2], ctrl_value: 1, clean_type: 0});
        });

        it("start() sends build_map instead when no rooms are known yet", async () => {
            const {robot, sent} = buildRobot(undefined);
            robot.state.map = {getSegments: () => []};

            await new KaercherBasicControlCapability({robot: robot}).start();

            assert.strictEqual(sent[0].name, "build_map");
            assert.deepStrictEqual(sent[0].params, {ctrl_value: 1});
            assert.strictEqual(sent[1].name, "set_room_clean");
            assert.deepStrictEqual(sent[1].params, {room_ids: [], ctrl_value: 1, clean_type: 0});
        });

        it("stop()/pause() send set_room_clean", async () => {
            const {robot, sent} = buildRobot(undefined);
            await new KaercherBasicControlCapability({robot: robot}).stop();
            await new KaercherBasicControlCapability({robot: robot}).pause();

            assert.strictEqual(sent[0].name, "set_room_clean");
            assert.strictEqual(sent[0].params.ctrl_value, 0);
            assert.strictEqual(sent[1].name, "set_room_clean");
            assert.strictEqual(sent[1].params.ctrl_value, 2);
        });
    });

    describe("while a zone clean is active (work_mode 30/31/32)", () => {
        for (const workMode of [30, 31, 32]) {
            it(`routes start/stop/pause through set_zone_clean for work_mode ${workMode}`, async () => {
                const {robot, sent} = buildRobot(workMode);
                const capability = new KaercherBasicControlCapability({robot: robot});

                await capability.start();
                await capability.stop();
                await capability.pause();

                assert.deepStrictEqual(sent, [
                    {name: "set_zone_clean", params: {ctrl_value: 1}},
                    {name: "set_zone_clean", params: {ctrl_value: 0}},
                    {name: "set_zone_clean", params: {ctrl_value: 2}}
                ]);
            });
        }

        it("does NOT route through set_zone_clean while idle (work_mode 35)", async () => {
            const {robot, sent} = buildRobot(35);
            await new KaercherBasicControlCapability({robot: robot}).start();

            assert.strictEqual(sent[0].name, "set_room_clean");
        });
    });

    describe("while a room clean is paused (work_mode 4/9/27/37/82)", () => {
        for (const workMode of [4, 9, 27, 37, 82]) {
            it(`start() resumes with an empty room_ids, not a fresh full-house list (work_mode ${workMode})`, async () => {
                const {robot, sent} = buildRobot(workMode);
                await new KaercherBasicControlCapability({robot: robot}).start();

                assert.strictEqual(sent[0].name, "set_room_clean");
                assert.deepStrictEqual(sent[0].params, {room_ids: [], ctrl_value: 1, clean_type: 0});
            });
        }
    });
});
