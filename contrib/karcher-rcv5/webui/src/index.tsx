import React from "react";
import {createRoot} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {SnackbarProvider} from "notistack";
import {CssBaseline, PaletteMode, ThemeProvider, useMediaQuery} from "@mui/material";
import {useLocalStorage} from "hooks";
import CapabilitiesProvider from "CapabilitiesProvider";
import {buildTheme} from "./theme";
import NavShell from "./NavShell";

const queryClient = new QueryClient();

const Root = (): React.ReactElement => {
    const prefersDarkMode = useMediaQuery("(prefers-color-scheme: dark)");
    // Same key as Valetudo's own UI, so the choice carries over between the two.
    const [paletteMode, setPaletteMode] = useLocalStorage<PaletteMode>("palette-mode", prefersDarkMode ? "dark" : "light");
    const theme = React.useMemo(() => buildTheme(paletteMode), [paletteMode]);

    return (
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <CssBaseline/>
                <SnackbarProvider maxSnack={3}>
                    <CapabilitiesProvider>
                        <NavShell paletteMode={paletteMode} setPaletteMode={setPaletteMode}/>
                    </CapabilitiesProvider>
                </SnackbarProvider>
            </ThemeProvider>
        </QueryClientProvider>
    );
};

const container = document.getElementById("root");

if (container) {
    createRoot(container).render(<Root/>);
}
