import React from "react";
import {Avatar, ListItem, ListItemAvatar, ListItemText} from "@mui/material";
import {ArrowForwardIos as ArrowIcon} from "@mui/icons-material";
import {useSheetNavigation} from "./SheetNavigationContext";

// Drop-in replacement for frontend/src/components/list_menu/LinkListMenuItem.tsx, swapped in by
// build.js. Same export and props, but navigates via the sheet instead of react-router's <Link>.
export const LinkListMenuItem: React.FunctionComponent<{
    url: string,
    primaryLabel: string,
    secondaryLabel: string,
    icon: React.ReactElement
}> = ({
    url,
    primaryLabel,
    secondaryLabel,
    icon
}): React.ReactElement => {
    const {open} = useSheetNavigation();

    return (
        <ListItem
            secondaryAction={
                <ArrowIcon />
            }
            style={{
                cursor: "pointer",
                userSelect: "none",
            }}
            role="link"
            tabIndex={0}
            onClick={() => {
                open(url);
            }}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    open(url);
                }
            }}
        >
            <ListItemAvatar>
                <Avatar>
                    {icon}
                </Avatar>
            </ListItemAvatar>
            <ListItemText
                primary={primaryLabel}
                secondary={secondaryLabel}
                style={{marginRight: "2rem"}}
            />
        </ListItem>
    );
};
