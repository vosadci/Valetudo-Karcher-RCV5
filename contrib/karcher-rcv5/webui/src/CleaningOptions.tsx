import React from "react";
import {Box, ButtonBase, Grid2, Paper, Typography} from "@mui/material";
import {
    Capability,
    capabilityToPresetType,
    PresetSelectionState,
    RobotAttributeClass,
    usePresetSelectionMutation,
    usePresetSelectionsQuery,
    useRobotAttributeQuery,
    useRobotInformationQuery,
} from "api";
import {useCapabilitiesSupported} from "CapabilitiesProvider";
import Attachments from "controls/Attachments";
import CurrentStatistics from "controls/CurrentStatistics";
import Dock from "controls/Dock";
import {getPresetIconOrLabel, presetFriendlyNames, sortPresets} from "presetUtils";

type PresetCapability = Capability.FanSpeedControl | Capability.WaterUsageControl | Capability.OperationModeControl;
type PresetValue = PresetSelectionState["value"];

// The card's wording. Fan presets are Valetudo's generic levels, mapped to the robot's own names in KaercherConst.PRESET_TO_WIND.
const PRESET_LABELS: Partial<Record<PresetCapability, Partial<Record<PresetValue, string>>>> = {
    [Capability.OperationModeControl]: {vacuum: "Vacuum", vacuum_and_mop: "Vac & Mop", mop: "Mop"},
    [Capability.FanSpeedControl]: {low: "Silent", medium: "Standard", high: "Medium", max: "Turbo"},
    [Capability.WaterUsageControl]: {low: "Low", medium: "Medium", high: "High"},
};

const usePresetValue = (capability: PresetCapability): PresetValue | undefined => {
    const {data} = useRobotAttributeQuery(RobotAttributeClass.PresetSelectionState, (attributes) => {
        return attributes.filter((attribute) => {
            return attribute.type === capabilityToPresetType[capability];
        })[0];
    });

    return data?.value;
};

// A row like the card's: label on the left, segmented buttons on the right. Compact rows show only
// the icon on inactive buttons, so four fan levels fit a narrow panel.
const PresetRow = (props: {
    capability: PresetCapability,
    label: string,
    compact?: boolean,
    disabled?: boolean,
    disabledOptions?: Array<PresetValue>,
}): React.ReactElement | null => {
    const {capability, label, compact, disabled, disabledOptions} = props;
    const current = usePresetValue(capability);
    const {data: presets} = usePresetSelectionsQuery(capability);
    const {mutate: selectPreset, isPending, variables: pendingValue} = usePresetSelectionMutation(capability);

    const options = React.useMemo(() => {
        return sortPresets((presets ?? []).filter((preset) => {
            return preset !== "custom";
        }));
    }, [presets]);

    if (options.length === 0) {
        return null;
    }

    const active = isPending ? pendingValue : current;

    return (
        <Box sx={{display: "flex", alignItems: "center", gap: "10px", py: "9px"}}>
            <Typography sx={{fontSize: 13, fontWeight: 600, color: "text.secondary", minWidth: "4.5em", flexShrink: 0}}>
                {label}
            </Typography>
            <Box
                sx={{
                    flex: 1,
                    display: "flex",
                    gap: "4px",
                    p: "4px",
                    borderRadius: "11px",
                    bgcolor: "action.selected",
                    opacity: disabled ? 0.4 : 1,
                    pointerEvents: disabled ? "none" : undefined,
                }}
            >
                {options.map((preset) => {
                    const isActive = preset === active;
                    const optionDisabled = disabled || disabledOptions?.includes(preset);
                    const text = PRESET_LABELS[capability]?.[preset] ?? presetFriendlyNames[preset];
                    const icon = getPresetIconOrLabel(capability, preset, {width: 14, height: 14});

                    return (
                        <ButtonBase
                            key={preset}
                            disabled={optionDisabled}
                            title={text}
                            aria-pressed={isActive}
                            onClick={() => {
                                if (!isActive) {
                                    selectPreset(preset);
                                }
                            }}
                            sx={{
                                flex: 1,
                                minWidth: 0,
                                height: 30,
                                px: 1,
                                gap: "5px",
                                borderRadius: "8px",
                                fontSize: 12,
                                fontWeight: isActive ? 700 : 600,
                                letterSpacing: "-0.01em",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                color: isActive ? "text.primary" : "text.secondary",
                                bgcolor: isActive ? "background.paper" : "transparent",
                                boxShadow: isActive ? "0 1px 3px rgba(0,0,0,0.15)" : "none",
                                opacity: optionDisabled && !disabled ? 0.35 : 1,
                                transition: "background 0.15s ease, color 0.15s ease, box-shadow 0.15s",
                                "& svg": {color: isActive ? "primary.dark" : "inherit", flexShrink: 0},
                            }}
                        >
                            {typeof icon !== "string" && icon}
                            {(!compact || isActive || typeof icon === "string") && <span>{text}</span>}
                        </ButtonBase>
                    );
                })}
            </Box>
        </Box>
    );
};

const MOP_MODES: Array<PresetValue> = ["vacuum_and_mop", "vacuum_then_mop", "mop"];

// Card behaviour: suction does nothing while only mopping, water does nothing while only vacuuming,
// and mop modes need the dustbin, the water tank and the mop cloth, as in the card (tank_state 3 and cloth_state 1).
// An attachment the robot hasn't reported yet counts as missing, as in the card.
const CleaningPresets = (props: {mode: boolean, fan: boolean, water: boolean}): React.ReactElement => {
    const mode = usePresetValue(Capability.OperationModeControl);
    const {data: attachments} = useRobotAttributeQuery(RobotAttributeClass.AttachmentState);
    const isAttached = (type: string): boolean => {
        return attachments?.some((attachment) => {
            return attachment.type === type && attachment.attached;
        }) ?? false;
    };
    const mopReady = isAttached("dustbin") && isAttached("watertank") && isAttached("mop");

    return (
        <Paper sx={{px: 1.5, py: 0.5, "& > *:not(:last-child)": {borderBottom: "1px solid", borderColor: "divider"}}}>
            {props.mode && (
                <PresetRow
                    capability={Capability.OperationModeControl}
                    label="Mode"
                    disabledOptions={mopReady ? undefined : MOP_MODES}
                />
            )}
            {props.fan && <PresetRow capability={Capability.FanSpeedControl} label="Suction" compact disabled={mode === "mop"}/>}
            {props.water && <PresetRow capability={Capability.WaterUsageControl} label="Water" compact disabled={mode === "vacuum"}/>}
        </Paper>
    );
};

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
                {(operationMode || fanSpeed || waterControl) && (
                    <CleaningPresets mode={operationMode} fan={fanSpeed} water={waterControl}/>
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
