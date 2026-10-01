import React from "react";

export interface SheetNavigation {
    // Opens the sheet on a page. Keys are Valetudo's own route paths, e.g. "/valetudo/about".
    open: (pageKey: string) => void,
    openMenu: () => void
}

const Context = React.createContext<SheetNavigation>({
    open: () => {
        // no-op outside a provider
    },
    openMenu: () => {
        // no-op outside a provider
    }
});

export const SheetNavigationProvider = Context.Provider;

export const useSheetNavigation = (): SheetNavigation => {
    return React.useContext(Context);
};
