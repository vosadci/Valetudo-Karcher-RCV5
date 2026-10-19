const ManualControlCapability = require("../../../core/capabilities/ManualControlCapability");

const MANUAL_WORK_MODE = 2;

const DIRECTION = Object.freeze({
    [ManualControlCapability.MOVEMENT_COMMAND_TYPE.FORWARD]: 1,
    [ManualControlCapability.MOVEMENT_COMMAND_TYPE.ROTATE_COUNTERCLOCKWISE]: 2,
    [ManualControlCapability.MOVEMENT_COMMAND_TYPE.ROTATE_CLOCKWISE]: 3,
    [ManualControlCapability.MOVEMENT_COMMAND_TYPE.BACKWARD]: 4
});

/**
 * `service.set_direction {direction: 1-4}`, device-verified on an RCV5 (karcher-rcv5-ha
 * doc/PROTOCOL.md §17). One publish is one short nudge, so there is no enable step.
 * The first nudge cancels any running clean. Exit is the same stop as the app's back button.
 *
 * @extends ManualControlCapability<import("../KaercherRCV5ValetudoRobot")>
 */
class KaercherManualControlCapability extends ManualControlCapability {
    /**
     * @param {object} options
     * @param {import("../KaercherRCV5ValetudoRobot")} options.robot
     */
    constructor(options) {
        super(Object.assign({}, options, {
            supportedMovementCommands: Object.keys(DIRECTION)
        }));

        this.active = false;
    }

    /**
     * @returns {Promise<void>}
     */
    async enableManualControl() {
        // The robot only enters manual drive (work_mode 2) on the first set_direction
        this.active = true;
    }

    /**
     * @returns {Promise<void>}
     */
    async disableManualControl() {
        const driving = this.robot.ephemeralState.work_mode === MANUAL_WORK_MODE;
        this.active = false;

        if (!driving) {
            return;
        }

        await this.robot.sendServiceInvoke("set_room_clean", {
            room_ids: [],
            ctrl_value: 0,
            clean_type: 0
        });
    }

    /**
     * @returns {Promise<boolean>}
     */
    async manualControlActive() {
        return this.active || this.robot.ephemeralState.work_mode === MANUAL_WORK_MODE;
    }

    /**
     * @param {import("../../../core/capabilities/ManualControlCapability").ValetudoManualControlMovementCommandType} movementCommand
     * @returns {Promise<void>}
     */
    async manualControl(movementCommand) {
        const direction = DIRECTION[movementCommand];

        if (direction === undefined) {
            throw new Error(`Invalid movementCommand: ${movementCommand}`);
        }

        await this.robot.sendServiceInvoke("set_direction", {direction: direction});
    }
}

module.exports = KaercherManualControlCapability;
