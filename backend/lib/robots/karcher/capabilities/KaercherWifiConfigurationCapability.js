const fs = require("fs");
const spawnSync = require("child_process").spawnSync;

const KaercherWifiApController = require("../KaercherWifiApController");
const LinuxWifiConfigurationCapability = require("../../common/linuxCapabilities/LinuxWifiConfigurationCapability");
const Logger = require("../../../Logger");
const misc = require("../../../utils/misc");
const ValetudoWifiConfiguration = require("../../../entities/core/ValetudoWifiConfiguration");

/**
 * Stage 1 (status, read-only) reused getWifiStatus() as-is from
 * LinuxWifiConfigurationCapability. Stage 2 adds reconfiguration, mirroring
 * contrib/karcher-rcv5/device/manage.sh's `do_wifi()` — the same
 * stage/verify/save wpa_cli sequence already live-confirmed working on this
 * device, just re-run here as this capability's setWifiConfiguration() instead
 * of an interactive on-device shell prompt.
 *
 * @extends LinuxWifiConfigurationCapability<import("../KaercherRCV5ValetudoRobot")>
 */
class KaercherWifiConfigurationCapability extends LinuxWifiConfigurationCapability {
    /**
     * @return {{provisionedReconfigurationSupported: boolean}}
     */
    getProperties() {
        return {
            provisionedReconfigurationSupported: true
        };
    }

    /**
     * @param {ValetudoWifiConfiguration} wifiConfig
     * @returns {Promise<void>}
     */
    async setWifiConfiguration(wifiConfig) {
        if (
            wifiConfig?.ssid === undefined ||
            wifiConfig.credentials?.type !== ValetudoWifiConfiguration.CREDENTIALS_TYPE.WPA2_PSK ||
            wifiConfig.credentials.typeSpecificSettings?.password === undefined
        ) {
            throw new Error("Invalid wifiConfig");
        }

        if (this.robot.wifiApController?.isApModeActive() === true) {
            // wpa_cli's staging flow below is impossible right now -- the radio is in AP
            // mode, wpa_supplicant isn't even running. Delegate to the controller, which
            // switches via wifiManager's own wifi.conf/wifi_reconnect mechanism instead.
            await this.robot.wifiApController.applyNewConfiguration(
                wifiConfig.ssid,
                wifiConfig.credentials.typeSpecificSettings.password
            );

            return;
        }

        if (spawnSync("pidof", ["wpa_supplicant"]).status !== 0) {
            throw new Error("wpa_supplicant is not running — something else is wrong first");
        }

        const ssid = wifiConfig.ssid;
        const password = wifiConfig.credentials.typeSpecificSettings.password;

        // select_network (below) disables every *other* configured network in
        // wpa_supplicant's live state, not just the new one — if the new network never
        // connects, just removing the staged one isn't enough to roll back: whatever was
        // previously connected would stay disabled until a reboot. Capture it now so the
        // failure path can explicitly re-select it.
        const previousNetId = this.getCurrentNetworkId();

        // Staged (added, not yet saved) network id. Cleared to undefined once there's
        // nothing left to roll back — either full success, or a live-but-unsaved
        // connection where removing it would sever the very thing that's now up.
        let netId;

        try {
            netId = this.runWpaCli(["add_network"]);
            this.runWpaCli(["set_network", netId, "ssid", `"${ssid}"`]);
            this.runWpaCli(["set_network", netId, "psk", `"${password}"`]);
            this.runWpaCli(["enable_network", netId]);
            this.runWpaCli(["select_network", netId]);

            let connected = false;
            for (let i = 0; i < 8; i++) {
                await misc.sleep(2000);

                if (this.runWpaCli(["status"], {allowFail: true}).includes("wpa_state=COMPLETED")) {
                    connected = true;
                    break;
                }
            }

            if (!connected) {
                throw new Error("Wi-Fi did not reach wpa_state=COMPLETED within ~16s — check the SSID/password");
            }

            const saveOutput = this.runWpaCli(["save_config"], {allowFail: true});
            if (!saveOutput.includes("OK")) {
                // Connected right now (wpa_state=COMPLETED above), just not persisted —
                // do NOT remove the network, that would sever the current connection.
                netId = undefined;
                throw new Error(`wpa_cli save_config did not reply OK (got: ${saveOutput}) — connected now, may not survive a reboot`);
            }

            netId = undefined;

            this.updateWifiConfNetwork(ssid, password);
            this.ensureWifiConfCloudFields();
        } finally {
            if (netId !== undefined) {
                spawnSync("wpa_cli", ["-i", this.networkInterface, "remove_network", netId]);

                if (previousNetId !== undefined) {
                    // Mirrors the same select_network call that put us in this situation —
                    // closest available match to "restore exactly what was selected before".
                    spawnSync("wpa_cli", ["-i", this.networkInterface, "select_network", previousNetId]);
                }
            }
        }
    }

    /**
     * @private
     * @return {string|undefined} the currently connected/selected network id, if any
     */
    getCurrentNetworkId() {
        const status = this.runWpaCli(["status"], {allowFail: true});
        const match = status.match(/^id=(\d+)$/m);

        return match?.[1];
    }

    /**
     * wpa_cli can reply "FAIL" while still exiting 0 — every call here is checked by its
     * actual text reply, matching manage.sh's own run_wpa() helper.
     *
     * @private
     * @param {Array<string>} args
     * @param {object} [options]
     * @param {boolean} [options.allowFail]
     * @return {string}
     */
    runWpaCli(args, options = {}) {
        const result = spawnSync("wpa_cli", ["-i", this.networkInterface, ...args]);
        const out = (result.stdout?.toString() ?? "").trim();

        if (options.allowFail !== true && out.includes("FAIL")) {
            throw new Error(`wpa_cli ${args.join(" ")} -> ${out}`);
        }

        return out;
    }

    /**
     * Keeps wifi.conf's ssid/psk in sync with whatever network wpa_supplicant just
     * actually connected to. Nothing used to do this on the STA path — only
     * wpa_supplicant.conf got updated — which left wifi.conf (and therefore
     * KaercherWifiApController's shadow copy of it) silently stale after a normal
     * reconfiguration through this path, manage.sh's do_wifi, or configure-wifi.sh. That
     * staleness would surface later as a bad AP-mode timeout/revert target: reverting to
     * a network wifi.conf remembers but wpa_supplicant.conf no longer has selected.
     *
     * @private
     * @param {string} ssid
     * @param {string} password
     */
    updateWifiConfNetwork(ssid, password) {
        const path = KaercherWifiConfigurationCapability.WIFI_CONF_PATH;
        let fields = {};

        try {
            fields = KaercherWifiApController.parseWifiConf(fs.readFileSync(path, "utf8"));
        } catch (e) {
            if (e.code !== "ENOENT") {
                throw e;
            }
        }

        fields.ssid = `"${ssid}"`;
        fields.psk = `"${password}"`;

        fs.writeFileSync(path, KaercherWifiApController.buildWifiConf(fields));
    }

    /**
     * Mirrors manage.sh's ensure_wifi_conf_cloud_fields(): without these fields,
     * Valetudo's dummycloud gets zero aiot_client communication
     * (project_rcv5_cloud_switch_region_fix memory) — a real risk here specifically
     * because reconfiguring Wi-Fi is one of the few things that could plausibly touch a
     * fresh/incomplete wifi.conf. Idempotent — only fills in fields that are missing.
     *
     * @private
     */
    ensureWifiConfCloudFields() {
        const path = KaercherWifiConfigurationCapability.WIFI_CONF_PATH;
        let content = "";

        try {
            content = fs.readFileSync(path, "utf8");
        } catch (e) {
            if (e.code !== "ENOENT") {
                throw e;
            }
        }

        const defaults = {
            uid: `unpaired-${process.pid}-${Math.floor(Date.now() / 1000)}`,
            key: `k${Math.floor(Date.now() / 1000)}-${process.pid}`,
            http_host: "eu-cdndevaiot.3irobotix.net",
            mqtt_host: "eu-gamqttaiot.3irobotix.net",
            mqtt_port: "8883",
            district: "DEU"
        };

        let appended = "";
        const addedKeys = [];
        Object.entries(defaults).forEach(([key, value]) => {
            if (!new RegExp(`^${key}=`, "m").test(content)) {
                appended += `${key}=${value}\n`;
                addedKeys.push(key);
            }
        });

        if (appended !== "") {
            fs.appendFileSync(path, appended);
            Logger.info(`KaercherWifiConfigurationCapability: added missing wifi.conf cloud fields: ${addedKeys.join(",")}`);
        }
    }
}

KaercherWifiConfigurationCapability.WIFI_CONF_PATH = "/userdata/config/wifi.conf";

module.exports = KaercherWifiConfigurationCapability;
