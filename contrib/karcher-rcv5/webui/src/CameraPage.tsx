import React from "react";
import {Alert, Box, Button, CircularProgress, Typography} from "@mui/material";
import {useQuery} from "@tanstack/react-query";
import mpegts from "mpegts.js";
import {valetudoAPI, valetudoAPIBaseURL} from "api";

const STREAM_URL = `${valetudoAPIBaseURL}/karcher/camera/stream`;

type Status = "connecting" | "playing" | "error";

// The camera image is a circle inside a 16:9 frame. 240 px off each side of 1920x1080 leaves 1440x1080, which is 4:3.
// The picture is sized to fit whatever room the sheet has: as wide as fits, but never taller than the space.
const VISIBLE_RATIO = 4 / 3;

const CameraPlayer = (): React.ReactElement => {
    const videoRef = React.useRef<HTMLVideoElement>(null);
    const frameRef = React.useRef<HTMLDivElement>(null);
    const [attempt, setAttempt] = React.useState(0);
    // Browser fullscreen where it exists, a full-window overlay where it doesn't (e.g. iPhone Safari).
    const [nativeFullscreen, setNativeFullscreen] = React.useState(false);
    const [overlay, setOverlay] = React.useState(false);
    const fullscreen = nativeFullscreen || overlay;
    const [status, setStatus] = React.useState<Status>("connecting");
    const [message, setMessage] = React.useState("");

    React.useEffect(() => {
        const video = videoRef.current;

        if (!video) {
            return;
        }

        setStatus("connecting");

        if (!mpegts.isSupported()) {
            setStatus("error");
            setMessage("This browser cannot play the camera stream.");
            return;
        }

        const player = mpegts.createPlayer(
            {type: "mpegts", isLive: true, url: STREAM_URL},
            {enableWorker: false, liveBufferLatencyChasing: true}
        );
        const onPlaying = () => {
            setStatus("playing");
        };

        player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
            setStatus("error");
            setMessage(
                detail === mpegts.ErrorDetails.NETWORK_UNRECOVERABLE_EARLY_EOF ?
                    "The camera is busy or just failed. Try again in a few seconds." :
                    `The camera stream stopped (${type}: ${detail}).`
            );
        });
        video.addEventListener("playing", onPlaying);
        player.attachMediaElement(video);
        player.load();
        Promise.resolve(player.play()).catch(() => {
            // Muted autoplay is normally allowed. A refusal leaves the spinner up.
        });

        return () => {
            video.removeEventListener("playing", onPlaying);
            player.destroy();
        };
    }, [attempt]);

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
    const {data, isPending, error} = useQuery({
        queryKey: ["karcher", "camera"],
        queryFn: async (): Promise<{enabled: boolean}> => {
            return (await valetudoAPI.get<{enabled: boolean}>("/karcher/camera/status")).data;
        },
        retry: false
    });

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
