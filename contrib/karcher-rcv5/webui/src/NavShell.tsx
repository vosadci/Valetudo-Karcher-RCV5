import React from "react";
import {PaletteMode} from "@mui/material";
import LiveMapPage from "map/LiveMapPage";
import RobotHeader from "./RobotHeader";
import ActionBar from "./ActionBar";
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
            <div style={{height: "100vh", display: "flex", flexDirection: "column"}}>
                <RobotHeader/>
                <div style={{flex: 1, minHeight: 0}}>
                    {/* Unmounted while the sheet is open so only one live map/WebSocket component runs at a time */}
                    {!sheetOpen && <LiveMapPage/>}
                </div>
                <ActionBar/>
            </div>
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
