import React from "react";
import {Box, PaletteMode} from "@mui/material";
import LiveMapPage from "map/LiveMapPage";
import {useIsMobileView} from "hooks/useIsMobileView";
import RobotHeader from "./RobotHeader";
import ActionBar from "./ActionBar";
import CleaningOptions from "./CleaningOptions";
import NavSheet from "./nav/NavSheet";
import {SheetNavigationProvider} from "./nav/SheetNavigationContext";
import {PAGE_REGISTRY} from "./nav/PageRegistry";

const NavShell = (props: {
    paletteMode: PaletteMode,
    setPaletteMode: (mode: PaletteMode) => void
}): React.ReactElement => {
    const [sheetOpen, setSheetOpen] = React.useState(false);
    const [sectionKey, setSectionKey] = React.useState<string | null>(null);
    const [pageKey, setPageKey] = React.useState<string | null>(null);
    const mobileView = useIsMobileView();

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
                {/* Same split as Valetudo's HomePage: below the sm breakpoint the controls sit under the map, above it they are a side panel */}
                <div style={{flex: 1, minHeight: 0, display: "flex"}}>
                    <div style={{flex: 1, minWidth: 0}}>
                        {/* Unmounted while the sheet is open so only one live map/WebSocket component runs at a time */}
                        {!sheetOpen && <LiveMapPage/>}
                    </div>
                    {!mobileView && (
                        <Box
                            sx={{
                                width: {sm: "33.33%", xl: "25%"},
                                minWidth: 320,
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
