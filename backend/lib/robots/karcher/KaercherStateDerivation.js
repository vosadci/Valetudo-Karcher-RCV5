const entities = require("../../entities");
const KaercherConst = require("./KaercherConst");

const stateAttrs = entities.state.attributes;

/**
 * Pure state-derivation functions, kept separate from KaercherRCV5ValetudoRobot so
 * the work_mode/fault decision tree — the part most likely to be subtly wrong — is
 * unit-testable without instantiating a full robot (mirrors karcher-rcv5-ha's own
 * `state.py`: "VacuumState + derive_vacuum_state (pure)").
 *
 * @param {object} ephemeralState
 * @param {number} [ephemeralState.work_mode]
 * @param {number} [ephemeralState.status]
 * @param {number} [ephemeralState.charge_state]
 * @param {number} [ephemeralState.fault]
 */

/**
 * Ports doc/PROTOCOL.md §6's decision tree verbatim (from coordinator.py):
 * ```
 * work_mode in CLEANING  → Cleaning
 * work_mode in GO_HOME:
 *   if docked             → Docked
 *   else                  → Returning
 * work_mode in PAUSE     → Paused
 * work_mode in IDLE:
 *   if docked             → Docked
 *   elif fault != 0       → Error
 *   else                  → Idle
 * unknown work_mode:
 *   if docked             → Docked
 *   else                  → Unknown (rendered as Idle in HA)
 * ```
 * docked := status === 4 || charge_state > 0. Codes in
 * KaercherConst.STATUS_ONLY_FAULT_CODES (the documented 21xx lifecycle
 * notifications, e.g. 2110 self-check, 2108 relocalizing) never promote to Error,
 * and their KaercherConst.STATUS_MESSAGES text (when a named constant exists) is
 * surfaced as statusMessage in every *non-docked* branch below (cleaning,
 * returning, paused, idle-undocked) — these codes coexist with an active
 * work_mode in practice, not just idle: relocalizing typically fires while the
 * robot is mid-GO_HOME (right after pickup, before it's settled back onto the
 * dock), so computing statusMessage only in the idle branch silently dropped
 * exactly the cases this feature exists for.
 *
 * DOCKED is deliberately excluded, never just "docked and undocked handled the
 * same way as everything else": `ephemeralState.fault` is a merge-only cache
 * (KaercherRCV5ValetudoRobot.js's parseAndUpdateState — only overwritten when a
 * push happens to include that key) with no expiry, and once the robot settles
 * into steady-state docked/charging, nothing ever pushes fault back to 0. A
 * status-only code from the brief docking transition (e.g. 2103 "Changing
 * state") then sticks forever, showing e.g. "Docked – Changing state" on an
 * otherwise perfectly idle, fully-charged robot. karcher-rcv5-ha's HA
 * integration hit and documented this exact failure (vacuum.py's
 * `_STATUS_LABEL`, device-verified 2026-06-24: 2102/2104/2105 persist through
 * the entire RETURNING/DOCKED period, not just the transition) and its own
 * `_derive_idle_state` avoids it structurally by returning DOCKED before ever
 * consulting `fault` — mirrored here the same way.
 *
 * @param {object} ephemeralState
 * @return {{value: import("../../entities/state/attributes/StatusStateAttribute").StatusStateAttributeValue, faultCode: number|undefined, statusMessage: string|undefined}}
 */
function deriveStatus(ephemeralState) {
    const {work_mode: workMode, status, charge_state: chargeState, fault} = ephemeralState;
    const docked = status === 4 || (typeof chargeState === "number" && chargeState > 0);
    const statusOnlyFault = !!fault && KaercherConst.STATUS_ONLY_FAULT_CODES.has(fault);
    const statusMessage = (!docked && statusOnlyFault) ? KaercherConst.STATUS_MESSAGES[fault] : undefined;

    if (workMode !== undefined && KaercherConst.WORK_MODE_SETS.CLEANING.includes(workMode)) {
        return {value: stateAttrs.StatusStateAttribute.VALUE.CLEANING, faultCode: undefined, statusMessage: statusMessage};
    }
    if (workMode !== undefined && KaercherConst.WORK_MODE_SETS.GO_HOME.includes(workMode)) {
        return {
            value: docked ? stateAttrs.StatusStateAttribute.VALUE.DOCKED : stateAttrs.StatusStateAttribute.VALUE.RETURNING,
            faultCode: undefined,
            statusMessage: statusMessage
        };
    }
    if (workMode !== undefined && KaercherConst.WORK_MODE_SETS.PAUSE.includes(workMode)) {
        return {value: stateAttrs.StatusStateAttribute.VALUE.PAUSED, faultCode: undefined, statusMessage: statusMessage};
    }
    if (workMode !== undefined && KaercherConst.WORK_MODE_SETS.IDLE.includes(workMode)) {
        if (docked) {
            return {value: stateAttrs.StatusStateAttribute.VALUE.DOCKED, faultCode: undefined, statusMessage: statusMessage};
        }
        if (fault && !statusOnlyFault) {
            return {value: stateAttrs.StatusStateAttribute.VALUE.ERROR, faultCode: fault, statusMessage: undefined};
        }
        return {
            value: stateAttrs.StatusStateAttribute.VALUE.IDLE,
            faultCode: undefined,
            statusMessage: statusMessage
        };
    }

    return {
        value: docked ? stateAttrs.StatusStateAttribute.VALUE.DOCKED : stateAttrs.StatusStateAttribute.VALUE.IDLE,
        faultCode: undefined,
        statusMessage: statusMessage
    };
}

/**
 * doc/PROTOCOL.md §6: "Actively charging" = charge_state == 1 && fault != 2105;
 * charging complete signalled by fault == 2105.
 *
 * @param {object} ephemeralState
 * @return {import("../../entities/state/attributes/BatteryStateAttribute").BatteryStateAttributeFlag}
 */
function deriveBatteryFlag(ephemeralState) {
    if (ephemeralState.charge_state === 1) {
        return ephemeralState.fault === 2105 ?
            stateAttrs.BatteryStateAttribute.FLAG.CHARGED :
            stateAttrs.BatteryStateAttribute.FLAG.CHARGING;
    }
    return stateAttrs.BatteryStateAttribute.FLAG.DISCHARGING;
}

/**
 * ZONE while a zone clean is running or paused. Returning is left unflagged, like
 * Viomi. The work_mode family comes from the APK (IotBase.getCleanMode == 6) and is
 * not device-verified.
 *
 * @param {object} ephemeralState
 * @param {import("../../entities/state/attributes/StatusStateAttribute").StatusStateAttributeValue} value
 * @return {import("../../entities/state/attributes/StatusStateAttribute").StatusStateAttributeFlag}
 */
function deriveStatusFlag(ephemeralState, value) {
    const flaggable = [
        stateAttrs.StatusStateAttribute.VALUE.CLEANING,
        stateAttrs.StatusStateAttribute.VALUE.PAUSED
    ].includes(value);

    if (flaggable && KaercherConst.ZONE_WORK_MODES.includes(ephemeralState.work_mode)) {
        return stateAttrs.StatusStateAttribute.FLAG.ZONE;
    }
    return stateAttrs.StatusStateAttribute.FLAG.NONE;
}

module.exports = {
    deriveStatus: deriveStatus,
    deriveStatusFlag: deriveStatusFlag,
    deriveBatteryFlag: deriveBatteryFlag
};
