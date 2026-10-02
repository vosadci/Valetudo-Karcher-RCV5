import React from "react";
import {alpha, Box, ButtonBase, CircularProgress, Theme, Typography} from "@mui/material";
import {Close as CloseIcon, Videocam as CameraIcon} from "@mui/icons-material";
import {useCameraStatusQuery, useCameraStream, VISIBLE_RATIO} from "../camera";

// Frosted control look, as the map's Rooms | Zone pill and Reset button
const frosted = (theme: Theme) => {
    return {
        bgcolor: alpha(theme.palette.background.paper, 0.78),
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: `1px solid ${alpha(theme.palette.text.primary, 0.14)}`,
        boxShadow: "0 6px 20px rgba(0,0,0,0.22)",
    };
};

// Small, or as large as the map leaves room for. cq units are the map area (containerType on its parent).
const SIZES = {
    small: `min(45cqw, calc(40cqh * ${VISIBLE_RATIO}), 320px)`,
    large: `min(calc(100cqw - 32px), calc((100cqh - 88px) * ${VISIBLE_RATIO}))`,
};

const FloatingCamera = (props: {onClose: () => void}): React.ReactElement => {
    const videoRef = React.useRef<HTMLVideoElement>(null);
    const [attempt, setAttempt] = React.useState(0);
    const [large, setLarge] = React.useState(false);
    const {status, message} = useCameraStream(videoRef, attempt);

    return (
        <Box
            onClick={() => {
                if (status === "error") {
                    setAttempt(attempt + 1);
                } else {
                    setLarge(!large);
                }
            }}
            title={status === "error" ? "Tap to retry" : "Tap to resize"}
            sx={{
                position: "absolute",
                left: 16,
                bottom: 16,
                zIndex: 6,
                width: large ? SIZES.large : SIZES.small,
                aspectRatio: VISIBLE_RATIO,
                borderRadius: "13px",
                overflow: "hidden",
                bgcolor: "#000",
                boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
                cursor: "pointer",
                userSelect: "none",
                transition: "width 0.2s ease",
            }}
        >
            <video
                ref={videoRef}
                muted
                autoPlay
                playsInline
                style={{width: "100%", height: "100%", objectFit: "cover", transform: "scaleY(-1)", display: "block"}}
            />
            {status === "connecting" && (
                <Box sx={{position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center"}}>
                    <CircularProgress size={28}/>
                </Box>
            )}
            {status === "error" && (
                <Box sx={{position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", p: 1.5}}>
                    <Typography variant="caption" align="center" sx={{color: "#fff"}}>
                        {message} Tap to retry.
                    </Typography>
                </Box>
            )}
            <ButtonBase
                title="Close camera"
                onClick={(e) => {
                    e.stopPropagation();
                    props.onClose();
                }}
                sx={(theme) => {
                    return {
                        ...frosted(theme),
                        position: "absolute",
                        top: 6,
                        right: 6,
                        width: 28,
                        height: 28,
                        borderRadius: "9px",
                        color: "text.primary",
                        "& svg": {fontSize: 16},
                    };
                }}
            >
                <CloseIcon/>
            </ButtonBase>
        </Box>
    );
};

// A camera button in the map's bottom-left corner that opens the camera over the map, so the robot can be
// watched with all controls at hand. Shown only while the Camera quirk is on. The stream runs only while
// the video is open.
const CameraOverlay = (props: {open: boolean, setOpen: (open: boolean) => void}): React.ReactElement | null => {
    const {data} = useCameraStatusQuery();

    if (data?.enabled !== true) {
        return null;
    }

    if (props.open) {
        return (
            <FloatingCamera
                onClose={() => {
                    props.setOpen(false);
                }}
            />
        );
    }

    return (
        <ButtonBase
            title="Show camera"
            onClick={() => {
                props.setOpen(true);
            }}
            sx={(theme) => {
                return {
                    ...frosted(theme),
                    position: "absolute",
                    left: 16,
                    bottom: 16,
                    zIndex: 6,
                    width: 44,
                    height: 44,
                    borderRadius: "13px",
                    color: alpha(theme.palette.text.primary, 0.82),
                    "& svg": {fontSize: 20},
                };
            }}
        >
            <CameraIcon/>
        </ButtonBase>
    );
};

export default CameraOverlay;
