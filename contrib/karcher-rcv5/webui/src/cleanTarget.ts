import {create} from "zustand";
import {Zone} from "api";

// What the live map has selected, shared with the action bar so its main button starts the matching
// clean. Published by the map action replacements in map/ (see build.js). null: no live map mounted.
export type CleanTarget =
    | {kind: "rooms", segments: string[], customOrder: boolean, iterations: number, clear: () => void}
    // Zones are read when the clean starts, so moves and resizes are always picked up
    | {kind: "zone", zoneCount: number, getZones: () => Zone[], iterations: number};

export const useCleanTarget = create<{target: CleanTarget | null, setTarget: (target: CleanTarget | null) => void}>()((set) => {
    return {
        target: null,
        setTarget: (target) => {
            set({target});
        },
    };
});
