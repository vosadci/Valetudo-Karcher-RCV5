import React from "react";
import {Box, Button, IconButton} from "@mui/material";
import HomeIcon from "@mui/icons-material/Home";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import TuneIcon from "@mui/icons-material/Tune";
import {useSheetNavigation} from "./nav/SheetNavigationContext";
import {useCleanTarget} from "./cleanTarget";
import {
    StatusState,
    useBasicControlMutation,
    useCleanSegmentsMutation,
    useCleanZonesMutation,
    useRobotStatusQuery,
} from "api";

const StartStates: Array<StatusState["value"]> = ["idle", "docked", "paused", "error"];
const PauseStates: Array<StatusState["value"]> = ["cleaning", "returning", "moving"];

const squareButtonSx = {
    width: 54,
    height: 54,
    borderRadius: "16px",
    border: "1px solid",
    borderColor: "divider",
} as const;

// inPanel: shown at the top of the wide-screen side panel, where the cleaning options are already visible.
const ActionBar = (props: {inPanel?: boolean}): React.ReactElement => {
    const {data: status} = useRobotStatusQuery();
    const target = useCleanTarget((state) => {
        return state.target;
    });
    const {mutate: sendCommand, isPending: basicPending} = useBasicControlMutation();
    const {mutate: cleanRooms, isPending: roomsPending} = useCleanSegmentsMutation({
        onSuccess: () => {
            const current = useCleanTarget.getState().target;

            if (current?.kind === "rooms") {
                current.clear();
            }
        },
    });
    // The zone stays on the map after the clean starts, as in the card
    const {mutate: cleanZones, isPending: zonesPending} = useCleanZonesMutation();
    const isPending = basicPending || roomsPending || zonesPending;
    const {open} = useSheetNavigation();

    const state = status?.value;
    const isCleaning = state !== undefined && PauseStates.includes(state);

    // One button for every clean: the map's mode and selection decide what it starts. Rooms the user
    // just selected win over resuming a paused clean; the zone is always there, so resuming wins over it.
    let primaryLabel = "Clean whole home";
    let startAction = () => {
        sendCommand("start");
    };
    let canStart = true;

    if (target?.kind === "rooms" && target.segments.length > 0) {
        primaryLabel = `Clean ${target.segments.length} ${target.segments.length === 1 ? "room" : "rooms"}`;
        startAction = () => {
            cleanRooms({segment_ids: target.segments, iterations: target.iterations, customOrder: target.customOrder});
        };
    } else if (status?.flag === "resumable") {
        primaryLabel = "Resume";
    } else if (target?.kind === "zone") {
        primaryLabel = "Clean zone";
        canStart = target.zoneCount > 0;
        startAction = () => {
            cleanZones({zones: target.getZones(), iterations: target.iterations});
        };
    }

    if (isCleaning) {
        primaryLabel = "Pause";
    }

    const primaryEnabled = state !== undefined && (isCleaning || (StartStates.includes(state) && canStart));

    const stopEnabled = status !== undefined && (status.flag === "resumable" || (state !== "idle" && state !== "docked"));
    const dockEnabled = state === "idle" || state === "error" || state === "paused";

    return (
        <Box
            sx={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: props.inPanel ? "14px 12px 10px" : "10px 16px calc(14px + env(safe-area-inset-bottom))",
                [props.inPanel ? "borderBottom" : "borderTop"]: "1px solid",
                borderColor: "divider",
                flexShrink: 0,
            }}
        >
            <Button
                variant="contained"
                color="primary"
                disabled={!primaryEnabled || isPending}
                onClick={() => {
                    if (isCleaning) {
                        sendCommand("pause");
                    } else {
                        startAction();
                    }
                }}
                sx={{flex: 1, height: 54, fontSize: 16}}
                startIcon={isCleaning ? <PauseIcon/> : <PlayArrowIcon/>}
            >
                {primaryLabel}
            </Button>
            <IconButton
                disabled={!stopEnabled || isPending}
                onClick={() => {
                    sendCommand("stop");
                }}
                sx={squareButtonSx}
            >
                <StopIcon/>
            </IconButton>
            <IconButton
                disabled={!dockEnabled || isPending}
                onClick={() => {
                    sendCommand("home");
                }}
                sx={squareButtonSx}
            >
                <HomeIcon/>
            </IconButton>
            {!props.inPanel && (
                <IconButton
                    onClick={() => {
                        open("/cleaning_options");
                    }}
                    aria-label="Cleaning options"
                    sx={squareButtonSx}
                >
                    <TuneIcon/>
                </IconButton>
            )}
        </Box>
    );
};

export default ActionBar;
