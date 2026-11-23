/**
 * Real video introspection using the browser's media stack.
 * - probeVideo: reads duration + resolution from the actual file and tells
 *   us whether the browser can decode it at all (corrupt / unsupported codec).
 * - captureThumbnail: grabs a real frame as a JPEG data URL for project cards.
 */

export interface VideoMeta {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  previewAvailable: boolean;
}

const PROBE_TIMEOUT_MS = 10_000;

export function probeVideo(source: Blob | string): Promise<VideoMeta> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const objectUrl = typeof source === "string" ? null : URL.createObjectURL(source);
    let settled = false;

    const finish = (meta: VideoMeta) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(meta);
    };

    const timer = window.setTimeout(
      () => finish({ durationSeconds: null, width: null, height: null, previewAvailable: false }),
      PROBE_TIMEOUT_MS
    );

    video.addEventListener("loadedmetadata", () => {
      finish({
        durationSeconds: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        previewAvailable: true,
      });
    });
    video.addEventListener("error", () => {
      finish({ durationSeconds: null, width: null, height: null, previewAvailable: false });
    });

    video.src = objectUrl ?? (source as string);
  });
}

/** Capture a frame ~25% into the video (or at 0.5s) as a 320px-wide JPEG data URL. */
export function captureThumbnail(source: Blob | string, durationSeconds: number | null): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    if (typeof source === "string" && /^https?:/i.test(source)) video.crossOrigin = "anonymous";
    const objectUrl = typeof source === "string" ? null : URL.createObjectURL(source);
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(value);
    };

    const timer = window.setTimeout(() => finish(null), PROBE_TIMEOUT_MS);

    video.addEventListener("loadedmetadata", () => {
      const target = durationSeconds ? Math.min(Math.max(durationSeconds * 0.25, 0.4), durationSeconds - 0.1) : 0.5;
      try {
        video.currentTime = Math.max(0, target);
      } catch {
        finish(null);
      }
    });
    video.addEventListener("seeked", () => {
      try {
        const width = 320;
        const height = Math.max(1, Math.round((width * (video.videoHeight || 9)) / (video.videoWidth || 16)));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish(null);
        ctx.drawImage(video, 0, 0, width, height);
        finish(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        finish(null); // cross-origin taint or decode failure
      }
    });
    video.addEventListener("error", () => finish(null));

    video.src = objectUrl ?? (source as string);
  });
}
