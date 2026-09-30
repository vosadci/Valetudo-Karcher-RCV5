import React from "react";
import {
    Box,
    Drawer,
    IconButton,
    List,
    ListItemButton,
    ListItemText,
    PaletteMode,
    Typography
} from "@mui/material";
import {
    ArrowBackIosNew as BackIcon,
    ArrowForwardIos as ArrowIcon,
    Close as CloseIcon
} from "@mui/icons-material";
import {PAGE_REGISTRY, SECTIONS} from "./PageRegistry";
import {useNavVisibility} from "./useNavVisibility";
import MenuFooter from "./MenuFooter";

interface NavSheetProps {
    open: boolean,
    sectionKey: string | null,
    pageKey: string | null,
    onSelectSection: (sectionKey: string) => void,
    onSelectPage: (pageKey: string) => void,
    onBack: () => void,
    onClose: () => void,
    paletteMode: PaletteMode,
    setPaletteMode: (mode: PaletteMode) => void
}

const NavSheet = (props: NavSheetProps): React.ReactElement => {
    const {open, sectionKey, pageKey, onSelectSection, onSelectPage, onBack, onClose, paletteMode, setPaletteMode} = props;

    const {isPageVisible, isSectionVisible} = useNavVisibility();

    const page = pageKey !== null ? PAGE_REGISTRY[pageKey] : undefined;
    const section = sectionKey !== null ? SECTIONS[sectionKey] : undefined;

    let title = "Menu";
    let body: React.ReactElement;

    if (page !== undefined) {
        const Page = page.component;

        title = page.title;
        body = <Page {...page.props}/>;
    } else if (section?.hub !== undefined) {
        const Hub = section.hub;

        title = section.title;
        body = <Hub/>;
    } else if (section !== undefined) {
        title = section.title;
        body = (
            <List>
                {section.pageKeys.filter(isPageVisible).map((key) => {
                    return (
                        <ListItemButton key={key} onClick={() => {
                            onSelectPage(key);
                        }}>
                            <ListItemText primary={PAGE_REGISTRY[key].title}/>
                            <ArrowIcon fontSize="small"/>
                        </ListItemButton>
                    );
                })}
            </List>
        );
    } else {
        body = (
            <>
            <List>
                {Object.entries(SECTIONS).filter(([key]) => isSectionVisible(key)).map(([key, def]) => {
                    return (
                        <ListItemButton key={key} onClick={() => {
                            onSelectSection(key);
                        }}>
                            <ListItemText primary={def.title}/>
                            <ArrowIcon fontSize="small"/>
                        </ListItemButton>
                    );
                })}
            </List>
            <MenuFooter paletteMode={paletteMode} setPaletteMode={setPaletteMode}/>
            </>
        );
    }

    const fill = page?.layout === "fill";
    const canGoBack = page !== undefined || section !== undefined;

    return (
        <Drawer
            anchor="bottom"
            open={open}
            onClose={onClose}
            slotProps={{
                paper: {
                    sx: {
                        height: "78%",
                        maxHeight: "78%",
                        borderRadius: "22px 22px 0 0",
                        display: "flex",
                        flexDirection: "column",
                    }
                }
            }}
        >
            <Box sx={{display: "flex", justifyContent: "center", padding: "14px 0 6px", flexShrink: 0}}>
                <Box sx={{width: 38, height: 5, borderRadius: "3px", backgroundColor: "divider"}}/>
            </Box>
            <Box sx={{display: "flex", alignItems: "center", gap: 1, padding: "0 8px 8px 8px", flexShrink: 0}}>
                <IconButton onClick={onBack} disabled={!canGoBack} aria-label="Back" sx={{visibility: canGoBack ? "visible" : "hidden"}}>
                    <BackIcon fontSize="small"/>
                </IconButton>
                <Typography sx={{flex: 1, fontWeight: 800, fontSize: 18, letterSpacing: "-0.025em"}} noWrap>
                    {title}
                </Typography>
                <IconButton onClick={onClose} aria-label="Close">
                    <CloseIcon/>
                </IconButton>
            </Box>
            <Box sx={{flex: 1, minHeight: 0, overflowY: fill ? "hidden" : "auto", padding: fill ? 0 : "0 0 24px 0"}}>
                <Box sx={{height: fill ? "100%" : undefined, display: fill ? "flex" : undefined, flexDirection: "column"}}>
                    {body}
                </Box>
            </Box>
        </Drawer>
    );
};

export default NavSheet;
