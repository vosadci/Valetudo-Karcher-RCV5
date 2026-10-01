import React from "react";
import {Box, Button, DialogContentText, IconButton} from "@mui/material";
import HomeIcon from "@mui/icons-material/Home";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import TuneIcon from "@mui/icons-material/Tune";
import ConfirmationDialog from "components/ConfirmationDialog";
import {usePendingMapAction} from "map/BaseMap";
import {useSheetNavigation} from "./nav/SheetNavigationContext";
import {BasicControlCommand, StatusState, useBasicControlMutation, useRobotStatusQuery} from "api";

const StartStates: Array<StatusState["value"]> = ["idle", "docked", "paused", "error"];
const PauseStates: Array<StatusState["value"]> = ["cleaning", "returning", "moving"];

const squareButtonSx = {
    width: 54,
    height: 54,
    borderRadius: "16px",
    border: "1px solid",
    borderColor: "divider",
} as const;

const ActionBar = (): React.ReactElement => {
    const {data: status} = useRobotStatusQuery();
    const {mutate: sendCommand, isPending} = useBasicControlMutation();
    const {open} = useSheetNavigation();
    const {hasPendingMapAction} = usePendingMapAction();
    const [startConfirmationOpen, setStartConfirmationOpen] = React.useState(false);

    const state = status?.value;
    const isCleaning = state !== undefined && PauseStates.includes(state);
    const primaryCommand: BasicControlCommand = isCleaning ? "pause" : "start";
    const primaryLabel = isCleaning ? "Pause" : (status?.flag === "resumable" ? "Resume" : "Start");
    const primaryEnabled = state !== undefined && (isCleaning || StartStates.includes(state));

    const stopEnabled = status !== undefined && (status.flag === "resumable" || (state !== "idle" && state !== "docked"));
    const dockEnabled = state === "idle" || state === "error" || state === "paused";

    return (
        <>
        <Box
            sx={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "10px 16px 14px",
                borderTop: "1px solid",
                borderColor: "divider",
                flexShrink: 0,
            }}
        >
            <Button
                variant="contained"
                color="primary"
                disabled={!primaryEnabled || isPending}
                onClick={() => {
                    if (primaryCommand === "start" && hasPendingMapAction) {
                        setStartConfirmationOpen(true);
                    } else {
                        sendCommand(primaryCommand);
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
            <IconButton
                onClick={() => {
                    open("/cleaning_options");
                }}
                aria-label="Cleaning options"
                sx={squareButtonSx}
            >
                <TuneIcon/>
            </IconButton>
        </Box>
        <ConfirmationDialog
            title="Are you sure you want to start a full cleanup?"
            open={startConfirmationOpen}
            onClose={() => {
                setStartConfirmationOpen(false);
            }}
            onAccept={() => {
                sendCommand("start");
            }}
        >
            <DialogContentText>
                You currently have a pending map action. You might instead be looking for the clean button on the map.
            </DialogContentText>
        </ConfirmationDialog>
        </>
    );
};

export default ActionBar;
