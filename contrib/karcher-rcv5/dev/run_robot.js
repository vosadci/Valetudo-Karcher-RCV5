// Manual live-test runner for KaercherRCV5ValetudoRobot — NOT part of the Valetudo
// module itself. Exercises the actual robot class (capabilities, state derivation,
// map pipeline) against the real robot, as opposed to run_dummycloud.js which only
// exercises KaercherAiotDummycloud in isolation.
//
//   sudo node contrib/karcher-rcv5/dev/run_robot.js
//
// Run from the Valetudo repo root. Only one of run_dummycloud.js / run_robot.js can
// be running at a time (both bind 443/8883).

const path = require("path");
const readline = require("readline");

const KaercherRCV5ValetudoRobot = require("../../../backend/lib/robots/karcher/KaercherRCV5ValetudoRobot.js");

// Override the (still-provisional) on-device cert paths and bind address with the
// dev-test ones — same trick as the local smoke tests during development (e.g.
// overriding KaercherAiotDummycloud.HTTP_PORT), not a change to the class itself.
// BIND_IP in particular matters: the class default (127.0.13.38) only works once
// Valetudo runs ON the robot; here it's running on this Mac, reached over the real
// LAN, so it needs to listen on all interfaces instead. The dev TLS cert lives one
// level up, in contrib/karcher-rcv5/ alongside gen_cert.py and install.sh.
KaercherRCV5ValetudoRobot.CERT_PATH = path.join(__dirname, "..", "server_v1.crt");
KaercherRCV5ValetudoRobot.KEY_PATH = path.join(__dirname, "..", "server.key");
KaercherRCV5ValetudoRobot.BIND_IP = "0.0.0.0";

const fakeConfig = {
    get: (key) => key === "embedded" ? true : undefined
};
const fakeEventStore = {
    raise: () => {},
    setProcessed: () => {}
};

const robot = new KaercherRCV5ValetudoRobot({config: fakeConfig, valetudoEventStore: fakeEventStore});

robot.onStateAttributesUpdated(() => {
    const status = robot.state.getFirstMatchingAttribute({attributeClass: "StatusStateAttribute"});
    const battery = robot.state.getFirstMatchingAttribute({attributeClass: "BatteryStateAttribute"});
    const fanSpeed = robot.state.getFirstMatchingAttribute({attributeClass: "PresetSelectionStateAttribute", attributeType: "fan_speed"});
    const waterGrade = robot.state.getFirstMatchingAttribute({attributeClass: "PresetSelectionStateAttribute", attributeType: "water_grade"});

    console.log(
        `>>> state: status=${status?.value}${status?.error ? ` (${status.error.message})` : ""} ` +
        `battery=${battery?.level}%/${battery?.flag} fan=${fanSpeed?.value} water=${waterGrade?.value}`
    );
});

robot.onMapUpdated(() => {
    const segments = robot.state.map.getSegments();
    console.log(`>>> map updated: ${robot.state.map.layers.length} layers, ${robot.state.map.entities.length} entities`);
    console.log(">>> segments:", segments.map(s => `${s.id}:${s.name}`).join(", "));
});

process.on("SIGINT", async () => {
    console.log("\nshutting down");
    await robot.shutdown();
    process.exit(0);
});

console.log("Commands: start | stop | pause | home | wind <low|medium|high|max> | water <low|medium|high> | segments | clean <id,id,...> | consumables | reset <brush|side_brush|filter|mop>");

const rl = readline.createInterface({input: process.stdin});
rl.on("line", async (line) => {
    const [cmd, arg] = line.trim().split(/\s+/);

    try {
        switch (cmd) {
            case "start":
                await robot.capabilities.BasicControlCapability.start();
                break;
            case "stop":
                await robot.capabilities.BasicControlCapability.stop();
                break;
            case "pause":
                await robot.capabilities.BasicControlCapability.pause();
                break;
            case "home":
                await robot.capabilities.BasicControlCapability.home();
                break;
            case "wind":
                await robot.capabilities.FanSpeedControlCapability.selectPreset(arg);
                break;
            case "water":
                await robot.capabilities.WaterUsageControlCapability.selectPreset(arg);
                break;
            case "segments": {
                const segments = robot.state.map.getSegments();
                console.log(segments.length ? segments.map(s => `${s.id}:${s.name}`).join(", ") : "(no map yet)");
                break;
            }
            case "clean": {
                const ids = (arg ?? "").split(",").filter(Boolean);
                const segments = robot.state.map.getSegments().filter(s => ids.includes(s.id));
                await robot.capabilities.MapSegmentationCapability.executeSegmentAction(segments);
                break;
            }
            case "consumables": {
                const consumables = await robot.capabilities.ConsumableMonitoringCapability.getConsumables();
                console.log(consumables.map(c => `${c.type}/${c.subType}: ${c.remaining.value}${c.remaining.unit}`).join(", ") || "(none pushed yet)");
                break;
            }
            case "reset": {
                const MAP = {brush: ["brush", "main"], side_brush: ["brush", "side_right"], filter: ["filter", "main"], mop: ["mop", "main"]};
                const [type, subType] = MAP[arg] ?? [];
                if (!type) {
                    console.log("unknown consumable, use: brush | side_brush | filter | mop");
                    break;
                }
                await robot.capabilities.ConsumableMonitoringCapability.resetConsumable(type, subType);
                break;
            }
            default:
                console.log(`unknown command '${cmd}'`);
        }
    } catch (e) {
        console.error("ERROR", e.message);
    }
});
