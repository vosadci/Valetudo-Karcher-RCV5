// Manual live-test runner for KaercherAiotDummycloud — NOT part of the Valetudo
// module itself, just a standalone way to point it at a real network interface for
// testing against the real robot. Needs root to bind ports 443/8883 on macOS:
//
//   sudo node contrib/karcher-rcv5/dev/run_dummycloud.js
//
// Run from the Valetudo repo root.

const fs = require("fs");
const path = require("path");
const KaercherStaticTLSContext = require("../../../backend/lib/robots/karcher/KaercherStaticTLSContext.js");
const KaercherAiotDummycloud = require("../../../backend/lib/robots/karcher/KaercherAiotDummycloud.js");

// The dev TLS cert lives one level up, in contrib/karcher-rcv5/ alongside
// gen_cert.py and install.sh — this script's own home is dev/.
const CERT_DIR = path.join(__dirname, "..");
const cert = fs.readFileSync(path.join(CERT_DIR, "server_v1.crt"), "utf8");
const key = fs.readFileSync(path.join(CERT_DIR, "server.key"), "utf8");
const tlsContext = new KaercherStaticTLSContext({cert, key});

const UPLOAD_DIR = path.join(__dirname, "map_captures");
fs.mkdirSync(UPLOAD_DIR, {recursive: true});

const cloud = new KaercherAiotDummycloud({
    tlsContext,
    bindIP: "0.0.0.0",
    onConnected: () => {
        console.log(">>> MQTT client connected");

        // sn is only learned from topics the robot publishes (see
        // KaercherAiotDummycloud's onPublish), not at CONNECT time itself, so
        // publishCommand() would reject immediately here — give it a few seconds of
        // real traffic first. Manually triggers the map-upload flow (step 7/8): the
        // real cloud sends this on its own schedule, which our dummycloud doesn't
        // replicate yet (that wiring is step 9's job, once there's a robot class to
        // react to state changes) — this is just enough to exercise the same
        // storage.specific_use_url / getAccessUrl / upload round-trip for testing.
        setTimeout(() => {
            cloud.publishCommand("service_invoke/upload_by_maptype", "service.upload_by_maptype", {map_type: 0})
                .then(() => console.log(">>> sent service.upload_by_maptype"))
                .catch(e => console.log(">>> failed to send service.upload_by_maptype:", e.message));
        }, 3000);
    },
    onIncomingCloudMessage: (topic, envelope) => {
        console.log(">>> INCOMING", topic);
        console.log(JSON.stringify(envelope, null, 2));
    },
    onSpecificUseUpload: (dir, body) => {
        // Saved as raw bytes, not decoded to text — whether the wire body is base64
        // text or binary is not yet confirmed (see KaercherAiotDummycloud.js).
        const filename = dir.replace(/\//g, "_") + ".bin";
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), body);
        console.log(`>>> UPLOAD dir='${dir}' (${body.length} bytes) -> ${filename}`);
    }
});

process.on("SIGINT", () => {
    console.log("\nshutting down");
    cloud.httpServer.close();
    cloud.mqttServer.close();
    process.exit(0);
});
