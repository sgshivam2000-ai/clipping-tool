export type ProjectStatus = "Uploading" | "Ready" | "Failed";
export type SourceType = "Upload" | "YouTube" | "Vimeo" | "URL";

export interface CaptionPrefs {
  style: "classic" | "bold" | "minimal";
  color: string;
  animation: "pop" | "fade" | "type";
  burnIn: boolean;
}

export interface Project {
  id: string;
  name: string;
  originalFileName: string;
  /** e.g. "storage/<uuid>.mp4" (server) or "indexeddb://clipforge/videos/<id>" (local) */
  storagePath: string;
  source: SourceType;
  status: ProjectStatus;
  createdAt: string; // ISO
  durationSeconds: number | null;
  duration: string; // formatted, e.g. "48:12" or "—"
  sizeBytes: number;
  size: string; // formatted, e.g. "812 MB"
  mimeType: string;
  width: number | null;
  height: number | null;
  /** JPEG data URL captured from the video, when the browser can decode it */
  thumbnail: string | null;
  /** false when the browser cannot decode the file (e.g. some MKV codecs) */
  previewAvailable: boolean;
  captionPrefs?: CaptionPrefs;
  /** Summary of the latest transcription job (the full transcript is fetched on demand). */
  transcriptStatus: TranscriptStatus;
  transcriptLanguage: string | null;
  momentStatus: MomentStatus;
  momentCandidateCount: number;
  clipsTotal: number;
  clipsCompleted: number;
}

/* ------------------------------- transcription ------------------------------ */

export type TranscriptStatus = "none" | "queued" | "processing" | "completed" | "failed";
export type TranscriptStage = "extracting_audio" | "loading_model" | "transcribing";

export interface TranscriptSegment {
  id: number;
  start: number; // seconds from the start of the video
  end: number; // seconds
  text: string;
}

export interface TranscriptResult {
  projectId: string;
  status: TranscriptStatus;
  stage: TranscriptStage | null;
  /** 0-100, measured from how much of the audio has been decoded so far (not a timer). */
  progress: number;
  model: string | null;
  language: string | null;
  languageProbability: number | null;
  durationSeconds: number | null;
  segmentCount: number;
  segments: TranscriptSegment[];
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}
export type MomentCategory = "Story" | "Funny" | "Educational" | "Emotional" | "Insight" | "Controversial" | "Motivational";

export interface MomentCandidate {
  id: string;
  rank: number;
  title: string;
  start: number;
  end: number;
  duration: number;
  hook: string;
  reason: string;
  engagementScore: number;
  category: MomentCategory;
  confidence: number;
  transcriptExcerpt: string;
  startSegmentId: number;
  endSegmentId: number;
  segmentIds: number[];
}

export interface MomentOptions {
  minDuration: number;
  maxDuration: number;
  maxCandidates: number;
}

export interface MomentResult {
  projectId: string;
  status: MomentStatus;
  stage: "preparing_context" | "analyzing_context" | "ranking_candidates" | null;
  provider: string | null;
  model: string | null;
  completedWindows: number;
  totalWindows: number;
  candidateCount: number;
  candidates: MomentCandidate[];
  warnings: string[];
  error: string | null;
  errorCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MomentEngineStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  connectivity: "not_checked";
  error: string | null;
  code: string | null;
  categories: MomentCategory[];
  defaults: { min_duration: number; max_duration: number; max_candidates: number };
}

export type StorageMode = "detecting" | "local" | "server";

export interface UploadState {
  fileName: string;
  progress: number; // 0-100
  status: "uploading" | "error";
  error?: string;
}

export interface NotificationItem {
  id: string;
  title: string;
  desc: string;
  time: string;
  unread: boolean;
}

/* ------------------------------- clip generation ---------------------------- */

export type ClipQuality = "low" | "standard" | "high";
export type ClipStatus = "queued" | "processing" | "completed" | "failed";

export interface ClipRecord {
  id: string;
  projectId: string;
  candidateId: string;
  title: string;
  rank: number | null;
  category: string | null;
  engagementScore: number | null;
  startSeconds: number;
  endSeconds: number;
  duration: number;
  quality: ClipQuality;
  status: ClipStatus;
  /** 0-100 for the current clip, measured from FFmpeg's out_time. */
  progress: number;
  error: string | null;
  errorCode: string | null;
  filePath: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ClipsSummary {
  projectId: string;
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  currentClip: ClipRecord | null;
  clips: ClipRecord[];
}

/* ------------------------------- vertical reframing ---------------------------- */

export type ReframeStatus = "none" | "queued" | "processing" | "completed" | "failed";
export type ReframeMethod = "face-tracked" | "center-crop-fallback";

export interface ReframeRecord {
  id: string | null;
  projectId: string;
  clipId: string;
  filePath: string | null;
  outputWidth: number | null;
  outputHeight: number | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  aspectRatio: string;
  status: ReframeStatus;
  /** 0-100 progress reported by the backend; 0-40 covers analysis, the rest rendering. */
  progress: number;
  method: ReframeMethod | null;
  quality: ClipQuality;
  sizeBytes: number | null;
  duration: number | null;
  error: string | null;
  errorCode: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export type MomentStatus = "none" | "queued" | "processing" | "completed" | "failed";
