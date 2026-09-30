import React from "react";
import {Box, Grid2} from "@mui/material";
import {AppRegistration as OperationModeIcon} from "@mui/icons-material";
import {Capability, useRobotInformationQuery} from "api";
import {useCapabilitiesSupported} from "CapabilitiesProvider";
import Attachments from "controls/Attachments";
import CurrentStatistics from "controls/CurrentStatistics";
import Dock from "controls/Dock";
import PresetSelectionControl from "controls/PresetSelection";
import {FanSpeedMediumIcon, WaterGradeLowIcon} from "components/CustomIcons";

// Valetudo's ControlsBody minus BasicControls and RobotStatus, which the shell's action bar and
// header already cover. Same per-panel gating as ControlsBody.
const CleaningOptions = (): React.ReactElement => {
    const [
        fanSpeed,
        waterControl,
        operationMode,
        triggerEmptySupported,
        mopDockCleanTriggerSupported,
        mopDockDryTriggerSupported,
        currentStatistics,
    ] = useCapabilitiesSupported(
        Capability.FanSpeedControl,
        Capability.WaterUsageControl,
        Capability.OperationModeControl,
        Capability.AutoEmptyDockManualTrigger,
        Capability.MopDockCleanManualTrigger,
        Capability.MopDockDryManualTrigger,
        Capability.CurrentStatistics
    );

    const {data: robotInformation} = useRobotInformationQuery();

    return (
        <Box sx={{padding: 1.5}}>
            <Grid2 container spacing={1.5} direction="column" sx={{userSelect: "none"}}>
                {operationMode && (
                    <PresetSelectionControl
                        capability={Capability.OperationModeControl}
                        label="Mode"
                        icon={<OperationModeIcon fontSize="small"/>}
                    />
                )}

                {fanSpeed && (
                    <PresetSelectionControl
                        capability={Capability.FanSpeedControl}
                        label="Fan"
                        icon={<FanSpeedMediumIcon fontSize="small"/>}
                    />
                )}

                {waterControl && (
                    <PresetSelectionControl
                        capability={Capability.WaterUsageControl}
                        label="Water"
                        icon={<WaterGradeLowIcon fontSize="small"/>}
                    />
                )}

                {(triggerEmptySupported || mopDockCleanTriggerSupported || mopDockDryTriggerSupported) && <Dock/>}

                {
                    robotInformation &&
                    robotInformation.modelDetails.supportedAttachments.length > 0 &&
                    <Attachments/>
                }

                {currentStatistics && <CurrentStatistics/>}
            </Grid2>
        </Box>
    );
};

export default CleaningOptions;
