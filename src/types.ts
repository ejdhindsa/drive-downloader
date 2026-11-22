export type TransferMode = 'staged' | 'direct';

export type ConflictPolicy = 'skip' | 'overwrite' | 'rename';

export type YtDlpFormat = 'best-mp4' | '1080p' | '720p' | 'audio-mp3' | 'audio-m4a';

export type JobStatus =
  | 'queued'
  | 'paused'
  | 'resolving'
  | 'downloading'
  | 'extracting'
  | 'uploading'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CustomHeader {
  name: string;
  value: string;
}

export interface JobProgress {
  percent: number;
  bytesDone: number;
  bytesTotal: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
}

export interface Job {
  id: string;
  url: string;
  partUrls?: string[];
  folder: string;
  subfolder: string;
  destinationRemote: string;
  customFilename?: string;
  resolvedFilename?: string;
  resolverName?: string;
  mode: TransferMode;
  conflictPolicy?: ConflictPolicy;
  ytDlpFormat?: YtDlpFormat;
  autoExtract: boolean;
  autoRefreshJellyfin: boolean;
  priority?: number;
  headers: CustomHeader[];
  status: JobStatus;
  phaseLabel: string;
  progress: JobProgress;
  logs: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface CreateJobsRequest {
  urls: string[];
  folder: string;
  existingSubfolder?: string;
  newSubfolder?: string;
  customFilename?: string;
  customFilenames?: Record<string, string>;
  mode: TransferMode;
  conflictPolicy?: ConflictPolicy;
  ytDlpFormat?: YtDlpFormat;
  autoExtract: boolean;
  archivePassword?: string;
  autoRefreshJellyfin: boolean;
  headers?: CustomHeader[];
}

export interface DiskStatus {
  freeBytes: number;
  totalBytes: number;
}

export interface CpuStats {
  percent: number;
  cores: number;
  loadAvg1m: number;
}

export interface MemoryStats {
  usedBytes: number;
  totalBytes: number;
  usedPercent: number;
}

export interface DriveQuotaStats {
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
}

export interface SystemStats {
  cpu: CpuStats;
  memory: MemoryStats;
  disk: DiskStatus & { usedPercent: number };
  driveQuota: DriveQuotaStats | null;
}

export type FileCategory = 'video' | 'archive' | 'audio' | 'book' | 'other';

export interface ResolvedTarget {
  downloadUrl: string;
  filename?: string;
  sizeBytes?: number;
  mimeType?: string;
  headers?: CustomHeader[];
  sourceUrl?: string;
  hoster: string;
  category?: FileCategory;
  engine?: 'aria2c' | 'yt-dlp';
  note?: string;
}

export interface InspectRequest {
  urls: string[];
  headers?: CustomHeader[];
}

export interface InspectResponse {
  items: ResolvedTarget[];
  warnings: string[];
  diskFreeBytes: number;
  minFreeDiskBytes: number;
  totalKnownBytes: number;
  fitsOnDisk: boolean;
}
