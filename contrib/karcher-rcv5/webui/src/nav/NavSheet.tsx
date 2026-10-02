import React from "react";
import {
    Box,
    Drawer,
    IconButton,
    List,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    PaletteMode,
    Typography
} from "@mui/material";
import {
    ArrowBackIosNew as BackIcon,
    ArrowForwardIos as ArrowIcon,
    Close as CloseIcon
} from "@mui/icons-material";
import PaperContainer from "components/PaperContainer";
import {ListMenu} from "components/list_menu/ListMenu";
import {PAGE_REGISTRY, SECTIONS} from "./PageRegistry";
import {useNavVisibility} from "./useNavVisibility";
import {LinkListMenuItem} from "./LinkListMenuItem";
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
        // Built from the same pieces as Valetudo's hub pages (e.g. ConnectivityOptions), so it looks the same
        title = section.title;
        body = (
            <PaperContainer>
                <ListMenu
                    primaryHeader={section.title}
                    secondaryHeader={section.description ?? ""}
                    listItems={section.pageKeys.filter(isPageVisible).map((key) => {
                        const def = PAGE_REGISTRY[key];
                        const Icon = def.icon ?? ArrowIcon;

                        return (
                            <LinkListMenuItem
                                key={key}
                                url={key}
                                primaryLabel={def.title}
                                secondaryLabel={def.description ?? ""}
                                icon={<Icon/>}
                            />
                        );
                    })}
                />
            </PaperContainer>
        );
    } else {
        // Laid out like the entries in Valetudo's own drawer (ValetudoAppBar.tsx)
        body = (
            <>
            <List sx={{userSelect: "none"}}>
                {Object.entries(SECTIONS).filter(([key]) => isSectionVisible(key)).map(([key, def]) => {
                    const Icon = def.icon;

                    return (
                        <ListItemButton key={key} onClick={() => {
                            if (def.page !== undefined) {
                                onSelectPage(def.page);
                            } else {
                                onSelectSection(key);
                            }
                        }}>
                            <ListItemIcon>
                                <Icon/>
                            </ListItemIcon>
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
