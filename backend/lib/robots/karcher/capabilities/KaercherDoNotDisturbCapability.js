const DoNotDisturbCapability = require("../../../core/capabilities/DoNotDisturbCapability");
const Logger = require("../../../Logger");
const ValetudoDNDConfiguration = require("../../../entities/core/ValetudoDNDConfiguration");

/**
 * PoC / debug build — NOT considered finished. See
 * `/Users/victor/.claude/plans/temporal-honking-treasure.md`, "Add Do Not Disturb" section.
 *
 * Built ahead of the plan's own Phase 0 gate, on purpose, so the real `set_quiet_time`/`prop.set`
 * wire calls plus a live WebUI toggle become the debug tool for settling the open questions
 * (timezone basis, DND-specific tz, the time-sync gate) instead of a one-off throwaway edit.
 * Whatever Phase 0 concludes may still require changes here — this is explicitly not final.
 *
 * Known gaps, intentional for now:
 * - Does NOT push a fresh `time_zone` on connect or on any schedule. Conversion uses whatever
 *   `time_zone` the robot has last reported (`ephemeralState.time_zone`), which may be `undefined`
 *   until a `prop.get` reply or unprompted push actually includes it — unconfirmed either way,
 *   see KaercherConst.ROBOT_PROPERTIES. Falls back to 0 (UTC) with a warning if unknown, purely so
 *   the getter/setter don't throw — this fallback is a debugging convenience, not a real design
 *   decision about which of the plan's 3 timezone-refresh options to ship.
 * - Does not enforce the app's own client-side validation (begin != end, <=18h window) — passes
 *   through and lets the robot accept/reject, per the plan's stated preference for never silently
 *   rewriting what the user asked for.
 *
 * @extends DoNotDisturbCapability<import("../KaercherRCV5ValetudoRobot")>
 */
class KaercherDoNotDisturbCapability extends DoNotDisturbCapability {
    /**
     * @returns {Promise<ValetudoDNDConfiguration>}
     */
    async getDndConfiguration() {
        const state = this.robot.ephemeralState;
        const timeZoneSec = state.time_zone ?? 0;

        if (state.time_zone === undefined) {
            Logger.warn("KaercherDoNotDisturbCapability: time_zone unknown, assuming UTC (0) — PoC fallback, not a real default");
        }

        const beginMinutesLocal = state.quiet_begin_time ?? 0;
        const endMinutesLocal = state.quiet_end_time ?? 0;

        const start = KaercherDoNotDisturbCapability.localMinutesToUtc(beginMinutesLocal, timeZoneSec);
        const end = KaercherDoNotDisturbCapability.localMinutesToUtc(endMinutesLocal, timeZoneSec);

        return new ValetudoDNDConfiguration({
            enabled: state.quiet_is_open === 1,
            start: {hour: start.hour, minute: start.minute},
            end: {hour: end.hour, minute: end.minute}
        });
    }

    /**
     * @param {ValetudoDNDConfiguration} dndConfig
     * @returns {Promise<void>}
     */
    async setDndConfiguration(dndConfig) {
        const state = this.robot.ephemeralState;
        const timeZoneSec = state.time_zone ?? 0;

        if (state.time_zone === undefined) {
            Logger.warn("KaercherDoNotDisturbCapability: time_zone unknown, assuming UTC (0) — PoC fallback, not a real default");
        }

        // Disabling reuses whatever begin/end is already on the robot — matches the app's own
        // behavior (QuietSettingActivity's switch handler resends the existing times with
        // is_open flipped; there is no separate "close"/disable command).
        let beginMinutesLocal = state.quiet_begin_time ?? 0;
        let endMinutesLocal = state.quiet_end_time ?? 0;

        if (dndConfig.enabled === true) {
            beginMinutesLocal = KaercherDoNotDisturbCapability.utcToLocalMinutes(
                dndConfig.start.hour,
                dndConfig.start.minute,
                timeZoneSec
            );
            endMinutesLocal = KaercherDoNotDisturbCapability.utcToLocalMinutes(
                dndConfig.end.hour,
                dndConfig.end.minute,
                timeZoneSec
            );
        }

        const payload = {
            is_open: dndConfig.enabled === true ? 1 : 0,
            quiet_begin_time: beginMinutesLocal,
            quiet_end_time: endMinutesLocal
        };

        // PoC diagnostic — the round-trip through getDndConfiguration() can't tell us anything
        // about the conversion, since the getter and setter share the same cached offset. This
        // is the only place that shows what actually went out on the wire.
        Logger.info(
            `KaercherDoNotDisturbCapability: set_quiet_time payload=${JSON.stringify(payload)} ` +
            `timeZoneSec=${timeZoneSec} timeZoneWasFallback=${state.time_zone === undefined}`
        );

        await this.robot.sendServiceInvoke("set_quiet_time", payload);

        // set_quiet_time is fire-and-forget, no guaranteed echo — same reasoning as every other
        // Karcher capability's setter (KaercherCarpetModeControlCapability etc.).
        this.robot.sendPropertyGet().catch(e => {
            Logger.warn("KaercherDoNotDisturbCapability: failed to refresh state", e);
        });
    }

    /**
     * Robot-local minutes-since-midnight -> UTC {hour, minute}. Real modulo, unlike Roborock's
     * `RoborockDoNotDisturbCapability.convertTime()`, whose `> dayInMinutes` boundary check lets
     * exactly 1440 through as "hour 24" — see the plan file for why that was flagged.
     *
     * @private
     * @param {number} localMinutes
     * @param {number} timeZoneSec seconds, positive east of UTC (matches the device's own sign
     *   convention — opposite of JS `Date.getTimezoneOffset()`)
     * @returns {{hour: number, minute: number}}
     */
    static localMinutesToUtc(localMinutes, timeZoneSec) {
        const offsetMinutes = timeZoneSec / 60;
        const utcMinutes = ((localMinutes - offsetMinutes) % 1440 + 1440) % 1440;

        return {
            hour: Math.floor(utcMinutes / 60),
            minute: Math.round(utcMinutes % 60)
        };
    }

    /**
     * Inverse of localMinutesToUtc.
     *
     * @private
     * @param {number} utcHour
     * @param {number} utcMinute
     * @param {number} timeZoneSec
     * @returns {number} robot-local minutes-since-midnight
     */
    static utcToLocalMinutes(utcHour, utcMinute, timeZoneSec) {
        const offsetMinutes = timeZoneSec / 60;
        const utcMinutes = utcHour * 60 + utcMinute;

        return Math.round(((utcMinutes + offsetMinutes) % 1440 + 1440) % 1440);
    }
}

module.exports = KaercherDoNotDisturbCapability;
