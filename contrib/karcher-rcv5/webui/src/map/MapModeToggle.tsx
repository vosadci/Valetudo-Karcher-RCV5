import React from "react";
import {alpha, Box, ButtonBase} from "@mui/material";
import {
    GridViewOutlined as RoomsIcon,
    HighlightAlt as ZoneIcon,
    Room as GoToIcon,
} from "@mui/icons-material";
import type {LiveMapMode} from "map/LiveMap";

// Replaces Valetudo's LiveMapModeSwitcher (see build.js) with the same export and props: the card's
// always-visible Rooms | Zone pill in the map's top-left corner, instead of a speed dial.
// Sizes and colours from the card's .map-mode CSS (styles-shell-a.js, karcher-rcv5-ha repo).
const MODES: Partial<Record<LiveMapMode, {label: string, icon: React.ReactElement}>> = {
    segments: {label: "Rooms", icon: <RoomsIcon/>},
    zones: {label: "Zone", icon: <ZoneIcon/>},
    goto: {label: "Go To", icon: <GoToIcon/>},
};

export const LiveMapModeSwitcher: React.FunctionComponent<{
    supportedModes: Array<LiveMapMode>,
    currentMode: LiveMapMode,
    setMode: (newMode: LiveMapMode) => void
}> = ({supportedModes, currentMode, setMode}) => {
    return (
        <Box
            role="group"
            aria-label="Map mode"
            sx={(theme) => {
                return {
                    position: "absolute",
                    top: 12,
                    left: 12,
                    zIndex: 6,
                    display: "flex",
                    gap: "3px",
                    p: "4px",
                    borderRadius: "13px",
                    bgcolor: alpha(theme.palette.background.paper, 0.78),
                    backdropFilter: "blur(10px)",
                    WebkitBackdropFilter: "blur(10px)",
                    border: `1px solid ${alpha(theme.palette.text.primary, 0.14)}`,
                    boxShadow: "0 6px 20px rgba(0,0,0,0.22)",
                };
            }}
        >
            {supportedModes.map((mode) => {
                const def = MODES[mode];

                if (!def) {
                    return null;
                }

                const active = mode === currentMode;

                return (
                    <ButtonBase
                        key={mode}
                        aria-pressed={active}
                        onClick={() => {
                            if (!active) {
                                setMode(mode);
                            }
                        }}
                        sx={{
                            height: 36,
                            px: "13px",
                            gap: "6px",
                            borderRadius: "10px",
                            fontSize: 13,
                            fontWeight: active ? 800 : 600,
                            color: active ? "primary.contrastText" : "text.primary",
                            bgcolor: active ? "primary.main" : "transparent",
                            transition: "background 0.15s ease, color 0.15s ease",
                            "& svg": {fontSize: 16},
                        }}
                    >
                        {def.icon}
                        {def.label}
                    </ButtonBase>
                );
            })}
        </Box>
    );
};
