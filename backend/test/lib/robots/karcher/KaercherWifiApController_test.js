const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherWifiApController = require("../../../../lib/robots/karcher/KaercherWifiApController");

describe("KaercherWifiApController", () => {
    describe("parseWifiConf()", () => {
        it("parses key=value lines into an object", () => {
            const content = [
                "ssid=\"h5\"",
                "psk=\"secret\"",
                "uid=unpaired-123",
                "http_host=eu-cdndevaiot.3irobotix.net"
            ].join("\n");

            assert.deepStrictEqual(KaercherWifiApController.parseWifiConf(content), {
                ssid: "\"h5\"",
                psk: "\"secret\"",
                uid: "unpaired-123",
                http_host: "eu-cdndevaiot.3irobotix.net"
            });
        });

        it("ignores blank lines and lines with no '='", () => {
            const content = "ssid=\"h5\"\n\nnot a valid line\npsk=\"secret\"\n";

            assert.deepStrictEqual(KaercherWifiApController.parseWifiConf(content), {
                ssid: "\"h5\"",
                psk: "\"secret\""
            });
        });

        it("returns an empty object for empty content", () => {
            assert.deepStrictEqual(KaercherWifiApController.parseWifiConf(""), {});
        });
    });

    describe("buildWifiConf()", () => {
        it("serializes fields back into key=value lines with a trailing newline", () => {
            const fields = {ssid: "\"h5\"", psk: "\"secret\""};

            assert.strictEqual(KaercherWifiApController.buildWifiConf(fields), "ssid=\"h5\"\npsk=\"secret\"\n");
        });

        it("omits fields whose value is undefined", () => {
            const fields = {ssid: "\"h5\"", psk: undefined, uid: "abc"};

            assert.strictEqual(KaercherWifiApController.buildWifiConf(fields), "ssid=\"h5\"\nuid=abc\n");
        });

        it("round-trips through parseWifiConf()", () => {
            const original = "ssid=\"h5\"\npsk=\"secret\"\nuid=unpaired-123\ndistrict=DEU\n";
            const roundTripped = KaercherWifiApController.buildWifiConf(KaercherWifiApController.parseWifiConf(original));

            assert.strictEqual(roundTripped, original);
        });
    });

    describe("applyCloudFieldDefaults()", () => {
        it("fills in only missing cloud fields, preserving existing ones", () => {
            const controller = new KaercherWifiApController({robot: undefined});
            const fields = {
                ssid: "\"h5\"",
                psk: "\"secret\"",
                http_host: "custom-host.example.com"
            };

            controller.applyCloudFieldDefaults(fields);

            assert.strictEqual(fields.ssid, "\"h5\"");
            assert.strictEqual(fields.psk, "\"secret\"");
            assert.strictEqual(fields.http_host, "custom-host.example.com");
            assert.strictEqual(fields.mqtt_host, "eu-gamqttaiot.3irobotix.net");
            assert.strictEqual(fields.mqtt_port, "8883");
            assert.strictEqual(fields.district, "DEU");
            assert.ok(fields.uid.startsWith("unpaired-"));
            assert.ok(fields.key.startsWith("k"));
        });

        it("adds all cloud fields when none are present", () => {
            const controller = new KaercherWifiApController({robot: undefined});
            const fields = {};

            controller.applyCloudFieldDefaults(fields);

            ["uid", "key", "http_host", "mqtt_host", "mqtt_port", "district"].forEach(key => {
                assert.ok(fields[key] !== undefined, `expected ${key} to be set`);
            });
        });
    });

    describe("applyNewConfiguration()", () => {
        it("rejects when not currently in AP_ACTIVE state", async () => {
            const controller = new KaercherWifiApController({robot: undefined});

            await assert.rejects(
                () => controller.applyNewConfiguration("SomeSSID", "password"),
                /Not currently in AP mode/
            );
        });
    });
});
