const assert = require("node:assert");
const { describe, it } = require("node:test");

const KaercherStateDerivation = require("../../../../lib/robots/karcher/KaercherStateDerivation");

describe("KaercherStateDerivation", () => {
    describe("deriveStatus", () => {
        it("maps every documented work_mode value to the correct status, per doc/PROTOCOL.md §6", () => {
            const CASES = [
                // [work_mode, status, charge_state, fault, expectedValue]
                [1, 0, 0, 0, "cleaning"],
                [7, 0, 0, 0, "cleaning"],
                [25, 0, 0, 0, "cleaning"],
                [30, 0, 0, 0, "cleaning"],
                [36, 0, 0, 0, "cleaning"],
                [81, 0, 0, 0, "cleaning"],

                [4, 0, 0, 0, "paused"],
                [9, 0, 0, 0, "paused"],
                [27, 0, 0, 0, "paused"],
                [31, 0, 0, 0, "paused"],
                [37, 0, 0, 0, "paused"],
                [82, 0, 0, 0, "paused"],

                [5, 0, 0, 0, "returning"],
                [10, 0, 0, 0, "returning"],
                [32, 0, 0, 0, "returning"],
                [47, 0, 0, 0, "returning"],
                [5, 4, 0, 0, "docked"], // GO_HOME + docked via status
                [5, 0, 1, 0, "docked"], // GO_HOME + docked via charge_state

                [0, 0, 0, 0, "idle"],
                [2, 0, 0, 0, "idle"], // manual drive
                [14, 0, 0, 0, "idle"],
                [35, 0, 0, 0, "idle"],
                [85, 0, 0, 0, "idle"],
                [0, 4, 0, 0, "docked"], // IDLE + docked via status
                [0, 0, 1, 0, "docked"], // IDLE + docked via charge_state
            ];

            CASES.forEach(([work_mode, status, charge_state, fault, expectedValue]) => {
                const result = KaercherStateDerivation.deriveStatus({work_mode: work_mode, status: status, charge_state: charge_state, fault: fault});
                assert.strictEqual(
                    result.value,
                    expectedValue,
                    `work_mode=${work_mode} status=${status} charge_state=${charge_state} fault=${fault} expected ${expectedValue}, got ${result.value}`
                );
            });
        });

        it("reports error only for IDLE work_mode, not docked, with a nonzero fault", () => {
            const result = KaercherStateDerivation.deriveStatus({work_mode: 0, status: 0, charge_state: 0, fault: 507});

            assert.strictEqual(result.value, "error");
            assert.strictEqual(result.faultCode, 507);
        });

        it("does not report error when docked, even with a nonzero fault (e.g. 2105 charge-finish)", () => {
            const result = KaercherStateDerivation.deriveStatus({work_mode: 0, status: 4, charge_state: 1, fault: 2105});

            assert.strictEqual(result.value, "docked");
            assert.strictEqual(result.faultCode, undefined);
        });

        it("does not report error for the app's documented status-only codes, even idle and undocked (isStatusNoThisFault() range, e.g. 2110 self-check)", () => {
            for (const statusOnlyCode of [2100, 2101, 2102, 2103, 2104, 2105, 2106, 2107, 2108, 2109, 2110, 2111, 2112, 2118]) {
                const result = KaercherStateDerivation.deriveStatus({work_mode: 0, status: 0, charge_state: 0, fault: statusOnlyCode});

                assert.strictEqual(result.value, "idle", `fault=${statusOnlyCode} should not report error`);
                assert.strictEqual(result.faultCode, undefined);
            }
        });

        it("surfaces a human-readable statusMessage for status-only codes with a named constant (e.g. 2110 self-check)", () => {
            const result = KaercherStateDerivation.deriveStatus({work_mode: 0, status: 0, charge_state: 0, fault: 2110});

            assert.strictEqual(result.value, "idle");
            assert.strictEqual(result.statusMessage, "Self-checking");
        });

        it("has no statusMessage for status-only codes with no named constant (2111/2112/2118)", () => {
            for (const unnamedCode of [2111, 2112, 2118]) {
                const result = KaercherStateDerivation.deriveStatus({work_mode: 0, status: 0, charge_state: 0, fault: unnamedCode});

                assert.strictEqual(result.value, "idle");
                assert.strictEqual(result.statusMessage, undefined, `fault=${unnamedCode} should have no statusMessage`);
            }
        });

        it("surfaces statusMessage while relocalizing mid-GO_HOME, not just when idle (e.g. right after pickup, before re-docking)", () => {
            const result = KaercherStateDerivation.deriveStatus({work_mode: 5, status: 0, charge_state: 0, fault: 2108});

            assert.strictEqual(result.value, "returning");
            assert.strictEqual(result.faultCode, undefined);
            assert.strictEqual(result.statusMessage, "Relocalizing");
        });

        it("surfaces statusMessage while cleaning (e.g. a scheduled/repeat clean in progress)", () => {
            const result = KaercherStateDerivation.deriveStatus({work_mode: 1, status: 0, charge_state: 0, fault: 2109});

            assert.strictEqual(result.value, "cleaning");
            assert.strictEqual(result.statusMessage, "Repeat cleaning in progress");
        });

        it("surfaces statusMessage while paused", () => {
            const result = KaercherStateDerivation.deriveStatus({work_mode: 4, status: 0, charge_state: 0, fault: 2103});

            assert.strictEqual(result.value, "paused");
            assert.strictEqual(result.statusMessage, "Changing state");
        });

        it("never surfaces statusMessage while docked, even for a status-only code (fault is a merge-only cache with no expiry — a code from the docking transition, e.g. 2103, would otherwise stick forever through steady-state charging)", () => {
            const viaGoHome = KaercherStateDerivation.deriveStatus({work_mode: 5, status: 4, charge_state: 1, fault: 2103});
            const viaIdle = KaercherStateDerivation.deriveStatus({work_mode: 0, status: 4, charge_state: 1, fault: 2105});
            const viaUnknownWorkMode = KaercherStateDerivation.deriveStatus({work_mode: 999, status: 4, charge_state: 1, fault: 2103});

            [viaGoHome, viaIdle, viaUnknownWorkMode].forEach((result) => {
                assert.strictEqual(result.value, "docked");
                assert.strictEqual(result.faultCode, undefined);
                assert.strictEqual(result.statusMessage, undefined);
            });
        });

        it("has no statusMessage for plain idle (fault: 0) or genuine errors", () => {
            assert.strictEqual(KaercherStateDerivation.deriveStatus({work_mode: 0, status: 0, charge_state: 0, fault: 0}).statusMessage, undefined);
            assert.strictEqual(KaercherStateDerivation.deriveStatus({work_mode: 0, status: 0, charge_state: 0, fault: 507}).statusMessage, undefined);
        });

        it("still reports error for genuine faults outside the status-only range (e.g. 2007/2010, just below 2100)", () => {
            for (const genuineFaultCode of [2007, 2010]) {
                const result = KaercherStateDerivation.deriveStatus({work_mode: 0, status: 0, charge_state: 0, fault: genuineFaultCode});

                assert.strictEqual(result.value, "error", `fault=${genuineFaultCode} should report error`);
                assert.strictEqual(result.faultCode, genuineFaultCode);
            }
        });

        it("does not report error when work_mode is undefined (never seen a push yet)", () => {
            const result = KaercherStateDerivation.deriveStatus({fault: 507});

            assert.strictEqual(result.value, "idle");
            assert.strictEqual(result.faultCode, undefined);
        });

        it("treats an unknown work_mode as docked or idle depending on dock state, not error", () => {
            assert.strictEqual(KaercherStateDerivation.deriveStatus({work_mode: 999, status: 0, charge_state: 0, fault: 507}).value, "idle");
            assert.strictEqual(KaercherStateDerivation.deriveStatus({work_mode: 999, status: 4, charge_state: 0, fault: 507}).value, "docked");
        });

        it("treats fault: 0 as no fault (idle, not error)", () => {
            const result = KaercherStateDerivation.deriveStatus({work_mode: 0, status: 0, charge_state: 0, fault: 0});

            assert.strictEqual(result.value, "idle");
            assert.strictEqual(result.faultCode, undefined);
        });
    });

    describe("deriveBatteryFlag", () => {
        it("is 'charging' when charge_state is 1 and fault is not 2105", () => {
            assert.strictEqual(KaercherStateDerivation.deriveBatteryFlag({charge_state: 1, fault: 0}), "charging");
            assert.strictEqual(KaercherStateDerivation.deriveBatteryFlag({charge_state: 1, fault: 507}), "charging");
        });

        it("is 'charged' when charge_state is 1 and fault is exactly 2105", () => {
            assert.strictEqual(KaercherStateDerivation.deriveBatteryFlag({charge_state: 1, fault: 2105}), "charged");
        });

        it("is 'discharging' when not on the dock", () => {
            assert.strictEqual(KaercherStateDerivation.deriveBatteryFlag({charge_state: 0, fault: 0}), "discharging");
            assert.strictEqual(KaercherStateDerivation.deriveBatteryFlag({}), "discharging");
        });
    });
});
