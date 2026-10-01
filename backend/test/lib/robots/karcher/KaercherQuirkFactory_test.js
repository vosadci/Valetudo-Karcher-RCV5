const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherQuirkFactory = require("../../../../lib/robots/karcher/KaercherQuirkFactory");
const KaercherRCV5ValetudoRobot = require("../../../../lib/robots/karcher/KaercherRCV5ValetudoRobot");

const FAKE_CONFIG = {
    get: (key) => key === "embedded" ? false : undefined
};

function buildRobot(privacy) {
    const robot = new KaercherRCV5ValetudoRobot({config: FAKE_CONFIG, valetudoEventStore: {}});

    robot.ephemeralState.privacy = privacy;

    const sentPropertySet = [];
    robot.sendPropertySet = async (params) => {
        sentPropertySet.push(params);
    };
    let propertyGetCalled = false;
    robot.sendPropertyGet = async () => {
        propertyGetCalled = true;
    };

    return {robot: robot, sentPropertySet: sentPropertySet, propertyGetCalled: () => propertyGetCalled};
}

describe("KaercherQuirkFactory", () => {
    it("getQuirk() throws for an unknown id", () => {
        const factory = new KaercherQuirkFactory({robot: buildRobot(undefined).robot});
        assert.throws(() => factory.getQuirk("not-a-real-id"));
    });

    describe("CARPET_DISPLAY quirk", () => {
        it("getter reflects privacy.carpet_show as 'on'/'off'", async () => {
            const on = new KaercherQuirkFactory({robot: buildRobot({carpet_show: 1}).robot})
                .getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.CARPET_DISPLAY);
            assert.strictEqual(await on.getter(), "on");

            const off = new KaercherQuirkFactory({robot: buildRobot({carpet_show: 0}).robot})
                .getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.CARPET_DISPLAY);
            assert.strictEqual(await off.getter(), "off");

            const unknown = new KaercherQuirkFactory({robot: buildRobot(undefined).robot})
                .getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.CARPET_DISPLAY);
            assert.strictEqual(await unknown.getter(), "off");
        });

        it("setter('on') sends privacy.carpet_show=1 and refreshes state", async () => {
            const {robot, sentPropertySet, propertyGetCalled} = buildRobot({carpet_show: 0});
            const quirk = new KaercherQuirkFactory({robot: robot})
                .getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.CARPET_DISPLAY);

            await quirk.setter("on");

            assert.deepStrictEqual(sentPropertySet, [{privacy: {carpet_show: 1}}]);
            assert.strictEqual(propertyGetCalled(), true);
        });

        it("setter('off') sends privacy.carpet_show=0", async () => {
            const {robot, sentPropertySet} = buildRobot({carpet_show: 1});
            const quirk = new KaercherQuirkFactory({robot: robot})
                .getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.CARPET_DISPLAY);

            await quirk.setter("off");

            assert.deepStrictEqual(sentPropertySet, [{privacy: {carpet_show: 0}}]);
        });

        it("setter() rejects any value other than 'on'/'off'", async () => {
            const {robot} = buildRobot({carpet_show: 0});
            const quirk = new KaercherQuirkFactory({robot: robot})
                .getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.CARPET_DISPLAY);

            await assert.rejects(() => quirk.setter("maybe"));
        });
    });

    describe("camera", () => {
        it("reflects and changes whether the camera is enabled", async () => {
            const calls = [];
            const robot = {
                cameraEnabled: false,
                setCameraEnabled: async (enabled) => {
                    calls.push(enabled);
                    robot.cameraEnabled = enabled;
                }
            };
            const quirk = new KaercherQuirkFactory({robot: robot}).getQuirk(KaercherQuirkFactory.KNOWN_QUIRKS.CAMERA);

            assert.strictEqual(await quirk.getter(), "off");
            await quirk.setter("on");
            assert.strictEqual(await quirk.getter(), "on");
            assert.deepStrictEqual(calls, [true]);
            await assert.rejects(quirk.setter("maybe"));
        });
    });
});
