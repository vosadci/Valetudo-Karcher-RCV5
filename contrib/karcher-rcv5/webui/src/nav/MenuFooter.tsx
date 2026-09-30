import React from "react";
import {
    Divider,
    List,
    ListItem,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    ListSubheader,
    PaletteMode,
    Switch
} from "@mui/material";
import {
    DarkMode as DarkModeIcon,
    GitHub as GithubIcon,
    MenuBook as DocsIcon
} from "@mui/icons-material";
import {SwaggerUIIcon, ValetudoHeartMonochromeIcon} from "components/CustomIcons";

// The dark-mode switch and Links block from Valetudo's own drawer (ValetudoAppBar.tsx).
const MenuFooter = (props: {
    paletteMode: PaletteMode,
    setPaletteMode: (mode: PaletteMode) => void
}): React.ReactElement => {
    const {paletteMode, setPaletteMode} = props;

    const linkItem = (href: string, icon: React.ReactElement, label: string) => {
        return (
            <ListItemButton component="a" href={href} target="_blank" rel="noopener">
                <ListItemIcon>{icon}</ListItemIcon>
                <ListItemText primary={label}/>
            </ListItemButton>
        );
    };

    return (
        <List sx={{userSelect: "none"}}>
            <Divider/>
            <ListItem>
                <ListItemIcon>
                    <DarkModeIcon/>
                </ListItemIcon>
                <ListItemText primary="Dark mode"/>
                <Switch
                    edge="end"
                    checked={paletteMode === "dark"}
                    onChange={(e) => {
                        setPaletteMode(e.target.checked ? "dark" : "light");
                    }}
                />
            </ListItem>
            <ListSubheader sx={{background: "transparent"}}>Links</ListSubheader>
            {linkItem("./swagger/", <SwaggerUIIcon/>, "Swagger UI")}
            {linkItem("https://valetudo.cloud", <DocsIcon/>, "Docs")}
            {linkItem("https://github.com/Hypfer/Valetudo", <GithubIcon/>, "Hypfer/Valetudo")}
            {linkItem("https://github.com/sponsors/Hypfer", <ValetudoHeartMonochromeIcon/>, "Donate")}
        </List>
    );
};

export default MenuFooter;
