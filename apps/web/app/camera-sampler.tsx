"use client";

import { useEffect, useState } from "react";
import { cameraAggregate, eyeAspectRatio, LEFT_EYE, RIGHT_EYE } from "@crossline/core";

const EVERY_MS = 20 * 60_000;
const WINDOW_MS = 20_000;
const FPS = 15;
const LAST_KEY = "crossline.camera.lastSampleAt";

/**
 * 摄像头精力采样 (docs/energy-and-ecosystem.md §8, decided 2026-10-14): only on a desktop (a fine pointer), only with its own consent,
 * only while this page is in front. Every twenty minutes it opens the camera for twenty seconds, reads face landmarks and the forehead's
 * average green on this machine with MediaPipe, and posts four numbers — blinks a minute, eye closure, a pulse estimate and its quality.
 * No frame, landmark or image is kept or sent; the camera is closed as soon as the window ends. A small chip says when it is on.
 */
export function CameraSampler() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia("(pointer: fine)").matches || !navigator.mediaDevices?.getUserMedia) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lastAt = () => { try { return Number(localStorage.getItem(LAST_KEY) ?? 0); } catch { return 0; } };
    const tick = async () => {
      if (stopped) return;
      timer = setTimeout(() => void tick(), 60_000);
      if (document.visibilityState !== "visible" || Date.now() - lastAt() < EVERY_MS) return;
      const consent = await fetch("/api/settings/energy-signals").then((response) => response.ok ? response.json() as Promise<{ camera?: boolean }> : {}).catch(() => ({}));
      if (!(consent as { camera?: boolean }).camera || stopped) return;
      try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch { /* sample anyway */ }
      setActive(true);
      try {
        const aggregate = await sampleWindow();
        if (aggregate) await fetch("/api/energy-observations", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "camera_aggregate", level: "uncalibrated", confidence: "low", aggregate }) });
      } catch (error) {
        // No camera, refused, or the model failed: said once in the console, tried again next window.
        console.warn("camera-sampler", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
      finally { setActive(false); }
    };
    timer = setTimeout(() => void tick(), 10_000);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);
  return active ? <span className="camera-chip" role="status">摄像头采样中（20 秒，只在本机计算）</span> : null;
}

/** One twenty-second window: landmarks and forehead colour per frame, reduced to the aggregate before anything leaves this function. */
async function sampleWindow() {
  // Loaded by the browser from this origin, not bundled: bundling rewrote MediaPipe's own dynamic import of its wasm loader.
  const vision = await import(/* webpackIgnore: true */ "/mediapipe-wasm/vision_bundle.mjs" as string) as typeof import("@mediapipe/tasks-vision");
  const { FaceLandmarker, FilesetResolver } = vision;
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe-wasm");
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate: "CPU" }, runningMode: "VIDEO", numFaces: 1 });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: FPS }, audio: false });
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  const canvas = document.createElement("canvas");
  canvas.width = 160; canvas.height = 120;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const ears: Array<number | undefined> = [];
  const green: number[] = [];
  try {
    await video.play();
    const started = performance.now();
    while (performance.now() - started < WINDOW_MS) {
      const now = performance.now();
      const result = landmarker.detectForVideo(video, now);
      const face = result.faceLandmarks[0];
      if (face && context) {
        const points = face.map((point) => ({ x: point.x * video.videoWidth, y: point.y * video.videoHeight }));
        const left = eyeAspectRatio(points, LEFT_EYE), right = eyeAspectRatio(points, RIGHT_EYE);
        ears.push(left !== undefined && right !== undefined ? (left + right) / 2 : undefined);
        // The forehead: a box above landmark 151 (between the brows and the hairline), on a small copy of the frame.
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const anchor = face[151]!;
        const x = Math.max(0, Math.round(anchor.x * canvas.width) - 8), y = Math.max(0, Math.round(anchor.y * canvas.height) - 10);
        const pixels = context.getImageData(x, y, 16, 8).data;
        let sum = 0;
        for (let i = 1; i < pixels.length; i += 4) sum += pixels[i]!;
        green.push(sum / (pixels.length / 4));
      } else {
        ears.push(undefined);
        green.push(green.at(-1) ?? 0);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1000 / FPS - (performance.now() - now))));
    }
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    landmarker.close();
  }
  return cameraAggregate(ears, green, FPS);
}
