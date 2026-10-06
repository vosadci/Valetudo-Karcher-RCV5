import React from "react";
import {Grid2, Typography} from "@mui/material";
import {useRobotStatusQuery, useZonePropertiesQuery, Zone} from "api";
import {ActionButton} from "map/Styled";
import {IterationsIcon} from "assets/icon_components/IterationsIcon";
import ZoneClientStructure from "map/structures/client_structures/ZoneClientStructure";
import {PointCoordinates} from "map/utils/types";
import {useCleanTarget} from "../cleanTarget";

const ZONE_ADD_DELAY_MS = 200;

// Replaces Valetudo's live-map ZoneActions (see build.js) with the same props. Zone mode always has a
// zone: one is added when the mode opens, and again if the user deletes it, so there is nothing to
// add or clear. The action bar's main button cleans it.
const ZoneTargetActions = (props: {
    zones: ZoneClientStructure[],
    convertPixelCoordinatesToCMSpace(coordinates: PointCoordinates): PointCoordinates,
    onClear(): void,
    onAdd(): void,
}): React.ReactElement | null => {
    const {zones, convertPixelCoordinatesToCMSpace, onAdd} = props;
    const {data: zoneProperties} = useZonePropertiesQuery();
    const {data: status} = useRobotStatusQuery((state) => {
        return state.value;
    });
    const setTarget = useCleanTarget((state) => {
        return state.setTarget;
    });
    const [iterations, setIterations] = React.useState(1);

    // Read through refs: LiveMap passes new closures on every render
    const latest = React.useRef({zones: zones, convertPixelCoordinatesToCMSpace: convertPixelCoordinatesToCMSpace, onAdd: onAdd});
    latest.current = {zones: zones, convertPixelCoordinatesToCMSpace: convertPixelCoordinatesToCMSpace, onAdd: onAdd};

    // Switching modes makes the map re-render its layer image in a background worker, and the layer
    // is blank until that finishes. Adding the zone draws the map right away, which would show that
    // blank frame, so wait for the worker first. A timing guess: on a slow device it can still flicker.
    React.useEffect(() => {
        if (zones.length > 0) {
            return;
        }

        const timer = setTimeout(() => {
            latest.current.onAdd();
        }, ZONE_ADD_DELAY_MS);

        return () => {
            clearTimeout(timer);
        };
    }, [zones.length]);

    React.useEffect(() => {
        const getZones = (): Zone[] => {
            const {zones: current, convertPixelCoordinatesToCMSpace: toCM} = latest.current;

            return current.map((zone) => {
                return {
                    points: {
                        pA: toCM({x: zone.x0, y: zone.y0}),
                        pB: toCM({x: zone.x1, y: zone.y0}),
                        pC: toCM({x: zone.x1, y: zone.y1}),
                        pD: toCM({x: zone.x0, y: zone.y1}),
                    },
                };
            });
        };

        setTarget({kind: "zone", zoneCount: zones.length, getZones: getZones, iterations: iterations});
    }, [zones.length, iterations, setTarget]);

    React.useEffect(() => {
        return () => {
            setTarget(null);
        };
    }, [setTarget]);

    const maxIterations = zoneProperties?.iterationCount.max ?? 1;
    const canClean = status === "idle" || status === "docked" || status === "paused" || status === "returning" || status === "error";

    if (maxIterations <= 1 && canClean) {
        return null;
    }

    return (
        <Grid2 container spacing={1} direction="row-reverse" flexWrap="wrap-reverse">
            {maxIterations > 1 && (
                <Grid2>
                    <ActionButton
                        color="inherit"
                        size="medium"
                        variant="extended"
                        style={{textTransform: "initial"}}
                        onClick={() => {
                            setIterations(iterations % maxIterations + 1);
                        }}
                        title="Iteration Count"
                    >
                        <IterationsIcon iterationCount={iterations}/>
                    </ActionButton>
                </Grid2>
            )}
            {!canClean && (
                <Grid2>
                    <Typography variant="caption" color="textSecondary">
                        Cannot start zone cleaning while the robot is busy
                    </Typography>
                </Grid2>
            )}
        </Grid2>
    );
};

export default ZoneTargetActions;
