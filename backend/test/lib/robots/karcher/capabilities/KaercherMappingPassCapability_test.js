const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherMappingPassCapability = require("../../../../../lib/robots/karcher/capabilities/KaercherMappingPassCapability");
const KaercherRCV5ValetudoRobot = require("../../../../../lib/robots/karcher/KaercherRCV5ValetudoRobot");

const FAKE_CONFIG = {
    get: (key) => key === "embedded" ? false : undefined
};

function buildRobot() {
    const robot = new KaercherRCV5ValetudoRobot({config: FAKE_CONFIG, valetudoEventStore: {}});

    const sent = [];
    robot.sendServiceInvoke = async (name, params) => {
        sent.push({name: name, params: params});
    };

    return {robot: robot, sent: sent};
}

describe("KaercherMappingPassCapability", () => {
    it("startMapping() sends build_map with ctrl_value: 1", async () => {
        const {robot, sent} = buildRobot();

        await new KaercherMappingPassCapability({robot: robot}).startMapping();

        assert.deepStrictEqual(sent, [
            {name: "build_map", params: {ctrl_value: 1}}
        ]);
    });
});
