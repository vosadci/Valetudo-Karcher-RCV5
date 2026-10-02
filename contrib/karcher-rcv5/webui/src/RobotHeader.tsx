import React from "react";
import {Box, IconButton, Typography} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import {
    Battery20,
    Battery30,
    Battery50,
    Battery60,
    Battery80,
    Battery90,
    BatteryCharging20,
    BatteryCharging30,
    BatteryCharging50,
    BatteryCharging60,
    BatteryCharging80,
    BatteryCharging90,
    BatteryChargingFull,
    BatteryFull,
} from "@mui/icons-material";
import ValetudoEvents from "components/ValetudoEvents";
import {useSheetNavigation} from "./nav/SheetNavigationContext";
import {RobotAttributeClass, StatusState, useRobotAttributeQuery, useRobotInformationQuery, useRobotMapQuery, useRobotStatusQuery, useValetudoCustomizationsQuery} from "api";

// Status-dot colours mirror the card's .status-dot rules (styles-shell-a.js).
const STATUS_COLOR: Partial<Record<StatusState["value"], string>> = {
    cleaning: "#4caf50",
    returning: "#1976d2",
    moving: "#1976d2",
    manual_control: "#1976d2",
    docked: "#4caf50",
    idle: "#4caf50",
    paused: "#ff9800",
    error: "#f44336",
};
const OFFLINE_COLOR = "#9e9e9e";

// The card's wording (i18n.js STATE_LABELS) for Valetudo's lowercase status values.
const STATUS_LABEL: Record<StatusState["value"], string> = {
    cleaning: "Cleaning",
    returning: "Returning",
    moving: "Moving",
    manual_control: "Manual control",
    docked: "Docked",
    idle: "Ready",
    paused: "Paused",
    error: "Error",
};

// MUI's seven battery steps, each covering the levels nearest to it
const BATTERY_STEPS: Array<{below: number, icon: React.ElementType, charging: React.ElementType}> = [
    {below: 25, icon: Battery20, charging: BatteryCharging20},
    {below: 40, icon: Battery30, charging: BatteryCharging30},
    {below: 55, icon: Battery50, charging: BatteryCharging50},
    {below: 70, icon: Battery60, charging: BatteryCharging60},
    {below: 85, icon: Battery80, charging: BatteryCharging80},
    {below: 95, icon: Battery90, charging: BatteryCharging90},
    {below: Infinity, icon: BatteryFull, charging: BatteryChargingFull},
];

const batteryIcon = (level: number, charging: boolean): React.ElementType => {
    const step = BATTERY_STEPS.find((s) => {
        return level < s.below;
    })!;

    return charging ? step.charging : step.icon;
};

const RobotHeader = (): React.ReactElement => {
    const {data: info} = useRobotInformationQuery();
    const {data: status} = useRobotStatusQuery();
    const {data: batteries} = useRobotAttributeQuery(RobotAttributeClass.BatteryState);
    const battery = batteries?.[0];
    const BatteryIcon = batteryIcon(battery?.level ?? 100, battery?.flag === "charging");
    const {openMenu} = useSheetNavigation();

    const {data: customizations} = useValetudoCustomizationsQuery();
    // Settings > Valetudo Options > Custom Friendly Name, falling back to the robot model.
    const friendlyName = customizations?.friendlyName?.trim();
    const robotName = friendlyName ? friendlyName : (info?.modelName ?? "Kärcher Robot");

    React.useEffect(() => {
        document.title = robotName;
    }, [robotName]);

    // The room being cleaned, worked out by the backend (KaercherMapParser.CURRENT_SEGMENT_ID)
    const {data: map} = useRobotMapQuery();
    const currentSegmentId = (map?.metaData as {currentSegmentId?: string} | undefined)?.currentSegmentId;
    const currentRoom = status?.value === "cleaning" && currentSegmentId !== undefined ?
        map?.layers.find((layer) => {
            return layer.metaData.segmentId === currentSegmentId;
        })?.metaData.name :
        undefined;

    const statusColor = status ? (STATUS_COLOR[status.value] ?? OFFLINE_COLOR) : OFFLINE_COLOR;

    return (
        <Box
            sx={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 1.5,
                padding: "12px 16px",
                borderBottom: "1px solid",
                borderColor: "divider",
                flexShrink: 0,
            }}
        >
            <Box sx={{display: "flex", flexDirection: "column", gap: "5px", minWidth: 0}}>
                <Typography sx={{fontWeight: 800, fontSize: 18, letterSpacing: "-0.025em"}} noWrap>
                    {robotName}
                </Typography>
                <Box sx={{display: "flex", alignItems: "center", gap: "7px", minWidth: 0}}>
                    <Box sx={{width: 10, height: 10, borderRadius: "50%", backgroundColor: statusColor, flexShrink: 0}}/>
                    <Typography sx={{fontSize: 13, fontWeight: 600, color: statusColor}} noWrap>
                        {status ? STATUS_LABEL[status.value] ?? status.value : "Unknown"}
                        {currentRoom ? ` · ${currentRoom}` : ""}
                        {/* Backend detail for the current state, e.g. "Self-checking" */}
                        {status?.message ? ` · ${status.message}` : ""}
                    </Typography>
                </Box>
            </Box>
            <Box sx={{display: "flex", alignItems: "center", gap: 1, flexShrink: 0}}>
                {battery !== undefined && (
                    <Box sx={{display: "flex", alignItems: "center", gap: "5px"}}>
                        <BatteryIcon
                            titleAccess={battery.flag === "charging" ? "Charging" : undefined}
                            sx={{
                                color: battery.level > 20 ? "#4caf50" : "#f44336",
                                transform: "rotate(90deg)",
                            }}
                        />
                        <Typography sx={{fontSize: 14, fontWeight: 700}}>
                            {Math.round(battery.level)}%
                        </Typography>
                    </Box>
                )}
                <ValetudoEvents/>
                <IconButton onClick={openMenu} aria-label="Menu">
                    <MenuIcon/>
                </IconButton>
            </Box>
        </Box>
    );
};

export default RobotHeader;
