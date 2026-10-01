import {createTheme, PaletteMode, Theme} from "@mui/material";

// Tokens copied from custom_components/karcher_home_robots/www/card/styles-shell-a.js
// (karcher-rcv5-ha repo, VERSION 1.36.8) — the accent is the only fixed colour in the
// card's own design, everything else there is an HA theme variable with no fixed value.
const ACCENT = "#FFD400";
const ACCENT_DEEP = "#E8BE00";
const ACCENT_TEXT = "#1a1a1a";

export const buildTheme = (mode: PaletteMode): Theme => {
    return createTheme({
        palette: {
            mode,
            primary: {
                main: ACCENT,
                dark: ACCENT_DEEP,
                contrastText: ACCENT_TEXT,
            },
        },
        typography: {
            fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, Roboto, Helvetica, Arial, sans-serif",
        },
        shape: {
            borderRadius: 14,
        },
        components: {
            MuiDialog: {
                styleOverrides: {
                    paper: {
                        borderRadius: 22,
                    },
                },
            },
            MuiListItemButton: {
                styleOverrides: {
                    root: {
                        borderRadius: 12,
                    },
                },
            },
            MuiAccordion: {
                styleOverrides: {
                    root: {
                        boxShadow: "none",
                        border: "1px solid",
                        borderColor: "rgba(128,128,128,0.25)",
                        borderRadius: 14,
                        "&:before": {display: "none"},
                    },
                },
            },
            MuiButton: {
                styleOverrides: {
                    root: {
                        borderRadius: 14,
                        fontWeight: 800,
                        textTransform: "none",
                    },
                },
            },
        },
    });
};
