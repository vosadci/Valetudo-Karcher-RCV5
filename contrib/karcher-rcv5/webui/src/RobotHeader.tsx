import React from "react";
import {Box, IconButton, Typography} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import BatteryChargingFullIcon from "@mui/icons-material/BatteryChargingFull";
import BatteryFullIcon from "@mui/icons-material/BatteryFull";
import ValetudoEvents from "components/ValetudoEvents";
import {useSheetNavigation} from "./nav/SheetNavigationContext";
import {RobotAttributeClass, StatusState, useRobotAttributeQuery, useRobotInformationQuery, useRobotStatusQuery, useValetudoCustomizationsQuery} from "api";

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

const RobotHeader = (): React.ReactElement => {
    const {data: info} = useRobotInformationQuery();
    const {data: status} = useRobotStatusQuery();
    const {data: batteries} = useRobotAttributeQuery(RobotAttributeClass.BatteryState);
    const battery = batteries?.[0];
    const BatteryIcon = battery?.flag === "charging" ? BatteryChargingFullIcon : BatteryFullIcon;
    const {openMenu} = useSheetNavigation();

    const {data: customizations} = useValetudoCustomizationsQuery();
    // Settings > Valetudo Options > Custom Friendly Name, falling back to the robot model.
    const friendlyName = customizations?.friendlyName?.trim();
    const robotName = friendlyName ? friendlyName : (info?.modelName ?? "Kärcher Robot");

    React.useEffect(() => {
        document.title = robotName;
    }, [robotName]);

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
                <Box sx={{display: "flex", alignItems: "center", gap: "7px"}}>
                    <Box sx={{width: 10, height: 10, borderRadius: "50%", backgroundColor: statusColor, flexShrink: 0}}/>
                    <Typography sx={{fontSize: 13, fontWeight: 600, color: statusColor}}>
                        {status?.value ?? "Unknown"}
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
