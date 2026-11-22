export type TransferMode = 'staged' | 'direct';

export type JobStatus =
  | 'queued'
  | 'paused'
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
  folder: string;
  subfolder: string;
  destinationRemote: string;
  customFilename?: string;
  resolvedFilename?: string;
  mode: TransferMode;
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

export interface SystemStatsResponse {
  cpu: CpuStats;
  memory: MemoryStats;
  disk: DiskStatus & { usedPercent: number };
  driveQuota: DriveQuotaStats | null;
}

export interface AppConfigResponse {
  rcloneRoot: string;
  jellyfinConfigured: boolean;
  rcloneRcConfigured: boolean;
  proxyConfigured: boolean;
  maxConcurrentJobs: number;
  minFreeDiskBytes: number;
  maxExtractBytes: number;
  disk: DiskStatus;
}

export interface FoldersResponse {
  root: string;
  path: string;
  folders: string[];
}

export interface CreateFolderResponse {
  root: string;
  path: string;
  remoteTarget: string;
}

export interface CreateJobsPayload {
  urls: string[];
  folder: string;
  existingSubfolder?: string;
  newSubfolder?: string;
  customFilename?: string;
  mode: TransferMode;
  autoExtract: boolean;
  autoRefreshJellyfin: boolean;
  headers?: CustomHeader[];
}

export interface RefreshResponse {
  rcloneRefreshed: boolean;
  jellyfinRefreshed: boolean;
  messages: string[];
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';
