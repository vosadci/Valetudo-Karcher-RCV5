import React from "react";
import {Box, PaletteMode, useMediaQuery} from "@mui/material";
import LiveMapPage from "map/LiveMapPage";
import RobotHeader from "./RobotHeader";
import ActionBar from "./ActionBar";
import CleaningOptions from "./CleaningOptions";
import NavSheet from "./nav/NavSheet";
import {SheetNavigationProvider} from "./nav/SheetNavigationContext";
import {PAGE_REGISTRY} from "./nav/PageRegistry";
import CameraOverlay from "./map/CameraOverlay";

// The side panel needs ~440px for the Mode and Suction rows' labels; the map needs room for its Rooms | Zone
// pill and Reset button. Below both together, switch to the phone layout instead of squeezing either.
const PANEL_MIN_WIDTH = 440;
const MAP_MIN_WIDTH = 400;

const NavShell = (props: {
    paletteMode: PaletteMode,
    setPaletteMode: (mode: PaletteMode) => void
}): React.ReactElement => {
    const [sheetOpen, setSheetOpen] = React.useState(false);
    const [sectionKey, setSectionKey] = React.useState<string | null>(null);
    const [pageKey, setPageKey] = React.useState<string | null>(null);
    const [cameraOpen, setCameraOpen] = React.useState(false);
    const mobileView = !useMediaQuery(`(min-width: ${PANEL_MIN_WIDTH + MAP_MIN_WIDTH}px)`, {noSsr: true});

    const navigation = React.useMemo(() => {
        return {
            open: (key: string) => {
                if (PAGE_REGISTRY[key] !== undefined) {
                    setPageKey(key);
                    setSheetOpen(true);
                }
            },
            openMenu: () => {
                setSectionKey(null);
                setPageKey(null);
                setSheetOpen(true);
            }
        };
    }, []);

    return (
        <SheetNavigationProvider value={navigation}>
            {/* 100dvh, not 100vh: on phones 100vh includes the area behind the browser's toolbars, which hid the action bar */}
            <Box sx={{height: "100vh", "@supports (height: 100dvh)": {height: "100dvh"}, display: "flex", flexDirection: "column"}}>
                <RobotHeader/>
                {/* Same split as Valetudo's HomePage: narrow windows get the controls under the map, wide ones a side panel */}
                <div style={{flex: 1, minHeight: 0, display: "flex"}}>
                    <div style={{flex: 1, minWidth: mobileView ? 0 : MAP_MIN_WIDTH, position: "relative", containerType: "size"}}>
                        {/* Unmounted while the sheet is open so only one live map/WebSocket component runs at a time.
                            The camera goes with it, so its stream stops too; it comes back when the sheet closes. */}
                        {!sheetOpen && <LiveMapPage/>}
                        {!sheetOpen && <CameraOverlay open={cameraOpen} setOpen={setCameraOpen}/>}
                    </div>
                    {!mobileView && (
                        <Box
                            sx={{
                                width: {xs: "33.33%", xl: "25%"},
                                minWidth: PANEL_MIN_WIDTH,
                                flexShrink: 0,
                                display: "flex",
                                flexDirection: "column",
                                borderLeft: "1px solid",
                                borderColor: "divider",
                            }}
                        >
                            <ActionBar inPanel/>
                            <Box sx={{flex: 1, overflow: "auto"}}>
                                <CleaningOptions/>
                            </Box>
                        </Box>
                    )}
                </div>
                {mobileView && <ActionBar/>}
            </Box>
            <NavSheet
                open={sheetOpen}
                sectionKey={sectionKey}
                pageKey={pageKey}
                onSelectSection={setSectionKey}
                onSelectPage={setPageKey}
                onBack={() => {
                    if (pageKey !== null) {
                        setPageKey(null);
                    } else {
                        setSectionKey(null);
                    }
                }}
                onClose={() => {
                    setSheetOpen(false);
                }}
                paletteMode={props.paletteMode}
                setPaletteMode={props.setPaletteMode}
            />
        </SheetNavigationProvider>
    );
};

export default NavShell;
