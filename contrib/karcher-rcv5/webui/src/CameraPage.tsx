import React from "react";
import {Alert, Box, Button, CircularProgress, Typography} from "@mui/material";
import {useCameraStatusQuery, useCameraStream, VISIBLE_RATIO} from "./camera";

// The picture is sized to fit whatever room the sheet has: as wide as fits, but never taller than the space.
const CameraPlayer = (): React.ReactElement => {
    const videoRef = React.useRef<HTMLVideoElement>(null);
    const frameRef = React.useRef<HTMLDivElement>(null);
    const [attempt, setAttempt] = React.useState(0);
    // Browser fullscreen where it exists, a full-window overlay where it doesn't (e.g. iPhone Safari).
    const [nativeFullscreen, setNativeFullscreen] = React.useState(false);
    const [overlay, setOverlay] = React.useState(false);
    const fullscreen = nativeFullscreen || overlay;
    const {status, message} = useCameraStream(videoRef, attempt);

    React.useEffect(() => {
        const onChange = () => {
            setNativeFullscreen(document.fullscreenElement === frameRef.current);
        };

        document.addEventListener("fullscreenchange", onChange);

        return () => {
            document.removeEventListener("fullscreenchange", onChange);
        };
    }, []);

    React.useEffect(() => {
        if (!overlay) {
            return;
        }

        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setOverlay(false);
            }
        };

        window.addEventListener("keydown", onKey);

        return () => {
            window.removeEventListener("keydown", onKey);
        };
    }, [overlay]);

    const toggleFullscreen = () => {
        const frame = frameRef.current;

        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {
                // Already leaving
            });
        } else if (overlay) {
            setOverlay(false);
        } else if (frame?.requestFullscreen) {
            frame.requestFullscreen().catch(() => {
                setOverlay(true);
            });
        } else {
            setOverlay(true);
        }
    };

    return (
        <Box sx={{display: "flex", flexDirection: "column", height: "100%", minHeight: 0, px: 2, pb: 2, boxSizing: "border-box"}}>
            <Box
                ref={frameRef}
                onDoubleClick={toggleFullscreen}
                sx={{
                    position: overlay ? "fixed" : "relative",
                    inset: overlay ? 0 : undefined,
                    zIndex: overlay ? 1400 : undefined,
                    width: "100%",
                    height: fullscreen ? "100%" : undefined,
                    flex: fullscreen ? undefined : 1,
                    minHeight: fullscreen ? undefined : 0,
                    containerType: "size",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    bgcolor: "#000",
                    borderRadius: fullscreen ? 0 : 2,
                    overflow: "hidden",
                    touchAction: "manipulation",
                    userSelect: "none"
                }}
            >
                <Box
                    sx={{
                        position: "relative",
                        width: `min(100cqw, calc(100cqh * ${VISIBLE_RATIO}))`,
                        aspectRatio: VISIBLE_RATIO,
                        overflow: "hidden"
                    }}
                >
                    <video
                        ref={videoRef}
                        muted
                        autoPlay
                        playsInline
                        style={{width: "100%", height: "100%", objectFit: "cover", transform: "scaleY(-1)"}}
                    />
                    {status === "connecting" && (
                        <Box sx={{position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center"}}>
                            <CircularProgress/>
                        </Box>
                    )}
                </Box>
            </Box>
            {status === "error" && (
                <Alert
                    severity="error"
                    sx={{mt: 2, flexShrink: 0}}
                    action={
                        <Button color="inherit" size="small" onClick={() => {
                            setAttempt(attempt + 1);
                        }}>
                            Retry
                        </Button>
                    }
                >
                    {message}
                </Alert>
            )}
            <Typography variant="caption" color="text.secondary" sx={{display: "block", mt: 2, flexShrink: 0}}>
                Double-click the video for full screen. The camera starts when you open this page and stops shortly after you leave it.
            </Typography>
        </Box>
    );
};

const CameraPage = (): React.ReactElement => {
    const {data, isPending, error} = useCameraStatusQuery();

    if (isPending) {
        return <Box sx={{p: 2}}><CircularProgress/></Box>;
    }

    if (error) {
        return <Box sx={{p: 2}}><Alert severity="error">Could not reach the camera: {error.message}</Alert></Box>;
    }

    if (!data.enabled) {
        return (
            <Box sx={{p: 2}}>
                <Alert severity="info">
                    The camera is turned off. Turn it on under Robot Options → Quirks → Camera.
                    While someone watches, the video is also reachable on the robot&apos;s network without a password.
                </Alert>
            </Box>
        );
    }

    return <CameraPlayer/>;
};

export default CameraPage;
