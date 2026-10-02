import React from "react";
import {alpha, Box, ButtonBase} from "@mui/material";
import {FitScreen as ResetIcon} from "@mui/icons-material";
import LiveMap from "map/LiveMap";

// Replaces LiveMap for LiveMapPage only (see build.js). Adds the card's "Reset" button, shown while
// the map is zoomed or panned. Valetudo fits the map once on mount; that view is saved and restored,
// so mode, room selection and zone stay as they are.
class ResettableLiveMap extends LiveMap {
    private defaultTransform: DOMMatrix | null = null;
    private zoomed = false;

    componentDidMount(): void {
        super.componentDidMount();
        this.defaultTransform = this.ctxWrapper.getTransform();
    }

    protected draw(): void {
        super.draw();
        this.updateZoomed();
    }

    private updateZoomed(): void {
        const current = this.ctxWrapper.getTransform();
        const initial = this.defaultTransform;

        if (initial === null) {
            return;
        }

        // Small tolerances so rounding after a gesture doesn't count as zoomed
        const zoomed = Math.abs(current.a / initial.a - 1) > 0.01 ||
            Math.abs(current.e - initial.e) > 2 ||
            Math.abs(current.f - initial.f) > 2;

        if (zoomed !== this.zoomed) {
            this.zoomed = zoomed;
            this.forceUpdate();
        }
    }

    private resetZoom(): void {
        const t = this.defaultTransform;

        if (t === null) {
            return;
        }

        this.ctxWrapper.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
        this.currentScaleFactor = this.ctxWrapper.getScaleFactor().scaleX;
        this.draw();
    }

    render(): React.ReactElement {
        return (
            <Box sx={{position: "relative", width: "100%", height: "100%"}}>
                {super.render()}
                {this.zoomed && (
                    // Sizes and colours from the card's .map-reset CSS (styles-shell-a.js, karcher-rcv5-ha repo)
                    <ButtonBase
                        title="Reset zoom"
                        onClick={() => {
                            this.resetZoom();
                        }}
                        sx={(theme) => {
                            return {
                                position: "absolute",
                                top: 12,
                                right: 12,
                                zIndex: 6,
                                gap: "7px",
                                height: 44,
                                px: "13px",
                                borderRadius: "13px",
                                fontSize: 13,
                                fontWeight: 600,
                                color: alpha(theme.palette.text.primary, 0.82),
                                bgcolor: alpha(theme.palette.background.paper, 0.78),
                                backdropFilter: "blur(10px)",
                                WebkitBackdropFilter: "blur(10px)",
                                border: `1px solid ${alpha(theme.palette.text.primary, 0.14)}`,
                                boxShadow: "0 6px 20px rgba(0,0,0,0.22)",
                                "& svg": {fontSize: 18},
                            };
                        }}
                    >
                        <ResetIcon/>
                        Reset
                    </ButtonBase>
                )}
            </Box>
        );
    }
}

export default ResettableLiveMap;
