import React from "react";
import {Grid2, Typography} from "@mui/material";
import {Clear as ClearIcon} from "@mui/icons-material";
import {useMapSegmentationPropertiesQuery, useRobotStatusQuery} from "api";
import {ActionButton} from "map/Styled";
import {IterationsIcon} from "assets/icon_components/IterationsIcon";
import {useCleanTarget} from "../cleanTarget";

// Replaces Valetudo's live-map SegmentActions (see build.js) with the same props. Instead of its own
// "Clean N segments" button, it hands the selection to the action bar, which starts the clean.
// Only the iteration toggle and Clear stay on the map.
const RoomSelectionActions = (props: {segments: string[], onClear(): void}): React.ReactElement | null => {
    const {segments, onClear} = props;
    const {data: mapSegmentationProperties} = useMapSegmentationPropertiesQuery();
    const {data: status} = useRobotStatusQuery((state) => {
        return state.value;
    });
    const setTarget = useCleanTarget((state) => {
        return state.setTarget;
    });
    const [iterations, setIterations] = React.useState(1);
    const customOrder = mapSegmentationProperties?.customOrderSupport ?? false;

    React.useEffect(() => {
        setTarget({kind: "rooms", segments: segments, customOrder: customOrder, iterations: iterations, clear: onClear});
    }, [segments, customOrder, iterations, onClear, setTarget]);

    React.useEffect(() => {
        return () => {
            setTarget(null);
        };
    }, [setTarget]);

    if (segments.length === 0) {
        return null;
    }

    const maxIterations = mapSegmentationProperties?.iterationCount.max ?? 1;
    const canClean = status === "idle" || status === "docked" || status === "paused" || status === "returning" || status === "error";

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
            <Grid2>
                <ActionButton color="inherit" size="medium" variant="extended" onClick={onClear}>
                    <ClearIcon style={{marginRight: "0.25rem", marginLeft: "-0.25rem"}}/>
                    Clear
                </ActionButton>
            </Grid2>
            {!canClean && (
                <Grid2>
                    <Typography variant="caption" color="textSecondary">
                        Cannot start room cleaning while the robot is busy
                    </Typography>
                </Grid2>
            )}
        </Grid2>
    );
};

export default RoomSelectionActions;
