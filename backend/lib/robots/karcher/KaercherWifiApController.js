const fs = require("fs");
const path = require("path");
const spawnSync = require("child_process").spawnSync;

const Logger = require("../../Logger");
const misc = require("../../utils/misc");

/**
 * Button-triggered open-AP Wi-Fi management for the RCV5. Live-confirmed 2026-09-29:
 * the stock two-top-buttons Wi-Fi-reset combo (RobotApp -> wifiManager, NOT the separate
 * GPIO81 recessed-reset button) brings up an open AP via wifiManager's own StartAp(),
 * which unlinks /userdata/config/wifi.conf as a side effect. wpa_supplicant.conf (the
 * actual saved Wi-Fi credentials) and the rest of /userdata/config are left alone.
 *
 * Three responsibilities, all routed through the same mechanism wifiManager itself
 * watches -- wifi.conf's presence/content and the /tmp/wifi_reconnect flag file -- never
 * by calling wpa_cli directly while AP mode is active (the radio is in AP mode; there is
 * no STA to configure):
 *
 * 1. Shadow-copy wifi.conf and restore it once AP mode ends, so the button's one real
 *    side effect (deleting wifi.conf) doesn't silently break Valetudo's cloud pairing
 *    until someone notices. Live-confirmed necessary: reproduced this exact failure
 *    (map/modes gone after a button press + reboot, fixed only once wifi.conf was
 *    manually restored) before this existed.
 * 2. A timeout: if AP mode is entered and nothing gets configured within
 *    DEFAULT_TIMEOUT_MS, automatically revert to the network that was active before,
 *    using the shadow copy from (1).
 * 3. An AP-mode path for KaercherWifiConfigurationCapability.setWifiConfiguration() to
 *    delegate into when the radio is currently in AP mode (wpa_cli's normal STA-based
 *    flow is impossible there) -- writes the new credentials into wifi.conf, lets
 *    wifiManager's own StopAp()/wpaConnect() do the actual switch, and reverts via (2)'s
 *    same mechanism if it doesn't connect in time.
 */
class KaercherWifiApController {
    /**
     * @param {object} options
     * @param {import("./KaercherRCV5ValetudoRobot")} options.robot
     */
    constructor(options) {
        this.robot = options.robot;
        this.interval = undefined;
        this.state = KaercherWifiApController.STATE.IDLE;
        this.apEnteredAt = undefined;
        this.consecutiveApInactiveTicks = 0;
    }

    start() {
        this.tick();

        this.interval = setInterval(() => {
            this.tick();
        }, KaercherWifiApController.CHECK_INTERVAL_MS);
    }

    stop() {
        if (this.interval !== undefined) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }

    /**
     * @private
     */
    tick() {
        try {
            const apActive = this.isApModeActive();

            if (apActive) {
                this.consecutiveApInactiveTicks = 0;
            } else {
                this.consecutiveApInactiveTicks++;
            }

            // A single "hostapd not running" reading is ambiguous during AP-mode ENTRY:
            // StartAp() deletes wifi.conf, THEN calls SoftApUp(), which does its own
            // killall/sleep(1)/hostapd-startup sequence -- so there's a real ~1-2s window
            // where wifi.conf is already gone but hostapd isn't up yet. Live-confirmed bug
            // without this debounce: a tick landing in that window looked exactly like "AP
            // mode already ended, restore wifi.conf now", which itself made wifiManager
            // immediately exit the AP session it had just entered (voice prompt "connecting
            // to the network" firing instantly, no user interaction). Require
            // AP_INACTIVE_CONFIRM_TICKS consecutive negative readings -- comfortably longer
            // than that entry window -- before treating "not active" as authoritative.
            const apConfirmedInactive = this.consecutiveApInactiveTicks >= KaercherWifiApController.AP_INACTIVE_CONFIRM_TICKS;

            switch (this.state) {
                case KaercherWifiApController.STATE.IDLE:
                    if (apActive) {
                        this.enterApActive();
                    } else if (apConfirmedInactive) {
                        if (fs.existsSync(KaercherWifiApController.WIFI_CONF_PATH)) {
                            this.refreshShadowIfChanged();
                        } else {
                            this.restoreFromShadow();
                        }
                    }
                    break;
                case KaercherWifiApController.STATE.AP_ACTIVE:
                    if (apConfirmedInactive) {
                        // Ended on its own -- wifiManager's native ~30min backstop, or
                        // someone power-cycled the robot. Nothing more to do here; IDLE's
                        // own restore-from-shadow branch picks up a still-missing
                        // wifi.conf on a later tick.
                        this.state = KaercherWifiApController.STATE.IDLE;
                    } else if (apActive && Date.now() - this.apEnteredAt >= KaercherWifiApController.DEFAULT_TIMEOUT_MS) {
                        this.revert("timeout").catch(e => {
                            Logger.warn("KaercherWifiApController: timeout revert failed", e);
                        });
                    }
                    break;
                case KaercherWifiApController.STATE.APPLYING:
                    // Owned by applyNewConfiguration()/performApModeSwitch() below --
                    // just wait for it to finish; it moves state to IDLE itself.
                    break;
                case KaercherWifiApController.STATE.REVERTING:
                    // Owned by revert() below.
                    break;
            }
        } catch (e) {
            Logger.warn("KaercherWifiApController: tick failed", e);
        }
    }

    /**
     * Simplest live-confirmed signal: hostapd's presence/absence tracked cleanly across
     * the whole live test -- present throughout the AP session, gone the moment normal
     * networking was restored, whether via a plain reboot or (expected, not yet
     * live-tested) the /tmp/wifi_reconnect flag.
     *
     * @return {boolean}
     */
    isApModeActive() {
        return spawnSync("pidof", ["hostapd"]).status === 0;
    }

    /**
     * The DEFAULT_TIMEOUT_MS clock starts here, at AP entry -- not when a client joins the
     * AP, not when the configuration page is opened. It's a single window covering both
     * "find and join the AP" and "fill in and submit the form", not two separate windows.
     * A slow-to-connect client eats into the same budget a slow-to-fill-in form does.
     *
     * @private
     */
    enterApActive() {
        this.state = KaercherWifiApController.STATE.AP_ACTIVE;
        this.apEnteredAt = Date.now();

        Logger.info(
            `KaercherWifiApController: AP mode detected, will revert in ${KaercherWifiApController.DEFAULT_TIMEOUT_MS}ms if nothing is configured`
        );
    }

    /**
     * Entry point for KaercherWifiConfigurationCapability.setWifiConfiguration() when
     * the radio is currently in AP mode.
     *
     * Returns almost immediately (the actual switch is scheduled a couple seconds out)
     * rather than waiting for the outcome -- the HTTP response needs a chance to reach
     * the browser before AP teardown starts, and once wifi.conf is written that teardown
     * begins on wifiManager's own next ~1s tick, not ours.
     *
     * @param {string} ssid
     * @param {string} password
     * @returns {Promise<void>}
     */
    async applyNewConfiguration(ssid, password) {
        if (this.state !== KaercherWifiApController.STATE.AP_ACTIVE) {
            throw new Error("Not currently in AP mode, or a Wi-Fi change is already in progress");
        }

        this.state = KaercherWifiApController.STATE.APPLYING;

        setTimeout(() => {
            this.performApModeSwitch(ssid, password).catch(e => {
                Logger.error("KaercherWifiApController: AP-mode Wi-Fi switch failed unexpectedly", e);
                this.state = KaercherWifiApController.STATE.IDLE;
            });
        }, KaercherWifiApController.APPLY_DELAY_MS);
    }

    /**
     * @private
     * @param {string} ssid
     * @param {string} password
     */
    async performApModeSwitch(ssid, password) {
        Logger.info(`KaercherWifiApController: applying new Wi-Fi configuration via AP mode (ssid=${ssid})`);

        const fields = this.readShadowFields();
        fields.ssid = `"${ssid}"`;
        fields.psk = `"${password}"`;
        this.applyCloudFieldDefaults(fields);

        fs.writeFileSync(KaercherWifiApController.WIFI_CONF_PATH, KaercherWifiApController.buildWifiConf(fields));
        fs.writeFileSync(KaercherWifiApController.WIFI_RECONNECT_FLAG_PATH, "");

        const switched = await this.waitForApDown();

        if (switched) {
            Logger.info("KaercherWifiApController: new Wi-Fi configuration applied successfully");
            // wifi.conf now holds the new, live-correct network -- the IDLE-state tick
            // logic will pick it up into the shadow on its own next pass.
            this.state = KaercherWifiApController.STATE.IDLE;
        } else {
            Logger.warn("KaercherWifiApController: new Wi-Fi configuration did not connect in time, reverting");
            await this.revert("new-configuration-failed");
        }
    }

    /**
     * Reverts to whatever network was active before AP mode was entered, using the
     * shadow copy of wifi.conf. Used both for the timeout path and when a freshly
     * submitted configuration fails to connect.
     *
     * @private
     * @param {string} reason
     */
    async revert(reason) {
        if (this.state === KaercherWifiApController.STATE.REVERTING) {
            return;
        }

        this.state = KaercherWifiApController.STATE.REVERTING;
        Logger.warn(`KaercherWifiApController: reverting AP mode (${reason})`);

        try {
            const shadow = fs.readFileSync(KaercherWifiApController.WIFI_CONF_SHADOW_PATH, "utf8");

            fs.writeFileSync(KaercherWifiApController.WIFI_CONF_PATH, shadow);
            fs.writeFileSync(KaercherWifiApController.WIFI_RECONNECT_FLAG_PATH, "");

            await this.waitForApDown();
        } catch (e) {
            Logger.warn("KaercherWifiApController: revert failed", e);
        }

        this.state = KaercherWifiApController.STATE.IDLE;
    }

    /**
     * @private
     * @return {Promise<boolean>} true if AP mode ended (hostapd gone) within the timeout
     */
    async waitForApDown() {
        for (let i = 0; i < KaercherWifiApController.SWITCH_POLL_ATTEMPTS; i++) {
            await misc.sleep(KaercherWifiApController.SWITCH_POLL_INTERVAL_MS);

            if (!this.isApModeActive()) {
                return true;
            }
        }

        return false;
    }

    /**
     * @private
     * @return {object}
     */
    readShadowFields() {
        try {
            return KaercherWifiApController.parseWifiConf(
                fs.readFileSync(KaercherWifiApController.WIFI_CONF_SHADOW_PATH, "utf8")
            );
        } catch (e) {
            if (e.code !== "ENOENT") {
                throw e;
            }

            return {};
        }
    }

    /**
     * Same defaults as KaercherWifiConfigurationCapability.ensureWifiConfCloudFields() --
     * kept here too since the AP-mode apply path builds wifi.conf directly rather than
     * going through that method, and should never write a file missing these fields
     * either (project_rcv5_cloud_switch_region_fix memory: without them Valetudo's
     * dummycloud gets zero aiot_client communication).
     *
     * @private
     * @param {object} fields mutated in place
     */
    applyCloudFieldDefaults(fields) {
        const defaults = {
            uid: `unpaired-${process.pid}-${Math.floor(Date.now() / 1000)}`,
            key: `k${Math.floor(Date.now() / 1000)}-${process.pid}`,
            http_host: "eu-cdndevaiot.3irobotix.net",
            mqtt_host: "eu-gamqttaiot.3irobotix.net",
            mqtt_port: "8883",
            district: "DEU"
        };

        Object.entries(defaults).forEach(([key, value]) => {
            if (fields[key] === undefined) {
                fields[key] = value;
            }
        });
    }

    /**
     * @private
     */
    refreshShadowIfChanged() {
        const current = fs.readFileSync(KaercherWifiApController.WIFI_CONF_PATH, "utf8");
        let shadow;

        try {
            shadow = fs.readFileSync(KaercherWifiApController.WIFI_CONF_SHADOW_PATH, "utf8");
        } catch (e) {
            if (e.code !== "ENOENT") {
                throw e;
            }
        }

        if (current !== shadow) {
            fs.mkdirSync(path.dirname(KaercherWifiApController.WIFI_CONF_SHADOW_PATH), {recursive: true});
            fs.writeFileSync(KaercherWifiApController.WIFI_CONF_SHADOW_PATH, current);

            Logger.info("KaercherWifiApController: refreshed wifi.conf shadow copy");
        }
    }

    /**
     * @private
     */
    restoreFromShadow() {
        let shadow;

        try {
            shadow = fs.readFileSync(KaercherWifiApController.WIFI_CONF_SHADOW_PATH, "utf8");
        } catch (e) {
            if (e.code === "ENOENT") {
                // Nothing to restore from -- e.g. wifi.conf never existed before Valetudo
                // was installed on this unit. Not this controller's problem to fix.
                return;
            }

            throw e;
        }

        fs.writeFileSync(KaercherWifiApController.WIFI_CONF_PATH, shadow);

        Logger.warn("KaercherWifiApController: wifi.conf was missing (AP mode ended without it), restored from shadow copy");
    }

    /**
     * @param {string} content
     * @return {object}
     */
    static parseWifiConf(content) {
        const fields = {};

        content.split("\n").forEach(line => {
            const match = line.match(/^(\w+)=(.*)$/);

            if (match) {
                fields[match[1]] = match[2];
            }
        });

        return fields;
    }

    /**
     * @param {object} fields
     * @return {string}
     */
    static buildWifiConf(fields) {
        return Object.entries(fields)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n") + "\n";
    }
}

KaercherWifiApController.STATE = Object.freeze({
    IDLE: "idle",
    AP_ACTIVE: "ap_active",
    APPLYING: "applying",
    REVERTING: "reverting"
});

KaercherWifiApController.CHECK_INTERVAL_MS = 5000;
KaercherWifiApController.AP_INACTIVE_CONFIRM_TICKS = 2;
// Single window from AP entry to auto-revert -- covers connecting to the AP AND
// submitting the form, not "connect" then a separate "configure" allowance. See
// enterApActive()'s doc comment.
KaercherWifiApController.DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
KaercherWifiApController.APPLY_DELAY_MS = 2000;
KaercherWifiApController.SWITCH_POLL_INTERVAL_MS = 2000;
KaercherWifiApController.SWITCH_POLL_ATTEMPTS = 30;
KaercherWifiApController.WIFI_CONF_PATH = "/userdata/config/wifi.conf";
KaercherWifiApController.WIFI_CONF_SHADOW_PATH = "/userdata/valetudo/wifi.conf.shadow";
KaercherWifiApController.WIFI_RECONNECT_FLAG_PATH = "/tmp/wifi_reconnect";

module.exports = KaercherWifiApController;
