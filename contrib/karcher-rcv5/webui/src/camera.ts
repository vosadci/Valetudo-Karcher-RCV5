import React from "react";
import {useQuery} from "@tanstack/react-query";
import mpegts from "mpegts.js";
import {valetudoAPI, valetudoAPIBaseURL} from "api";

const STREAM_URL = `${valetudoAPIBaseURL}/karcher/camera/stream`;

export type CameraStatus = "connecting" | "playing" | "error";

// The camera image is a circle inside a 16:9 frame. 240 px off each side of 1920x1080 leaves 1440x1080, which is 4:3.
export const VISIBLE_RATIO = 4 / 3;

export const useCameraStatusQuery = () => {
    return useQuery({
        queryKey: ["karcher", "camera"],
        queryFn: async (): Promise<{enabled: boolean}> => {
            return (await valetudoAPI.get<{enabled: boolean}>("/karcher/camera/status")).data;
        },
        retry: false
    });
};

// Plays the camera stream in the given video element. Bump `attempt` to reconnect.
export const useCameraStream = (
    videoRef: React.RefObject<HTMLVideoElement | null>,
    attempt: number
): {status: CameraStatus, message: string} => {
    const [status, setStatus] = React.useState<CameraStatus>("connecting");
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
    }, [videoRef, attempt]);

    return {status, message};
};
