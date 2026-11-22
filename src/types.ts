export type TransferMode = 'staged' | 'direct';

export type JobStatus =
  | 'queued'
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
  mode: TransferMode;
  autoExtract: boolean;
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
