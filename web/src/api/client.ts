import type {
  AppConfigResponse,
  CreateJobsPayload,
  FoldersResponse,
  Job,
  RefreshResponse,
  SystemStatsResponse,
} from './types';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    const errMsg =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed (HTTP ${res.status})`;
    throw new Error(errMsg);
  }

  return data as T;
}

export function fetchConfig(): Promise<AppConfigResponse> {
  return requestJson<AppConfigResponse>('/api/config');
}

export function fetchStats(): Promise<SystemStatsResponse> {
  return requestJson<SystemStatsResponse>('/api/stats');
}

export function fetchFolders(path = '', refresh = false): Promise<FoldersResponse> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (refresh) params.set('refresh', '1');
  const query = params.toString();
  return requestJson<FoldersResponse>(`/api/folders${query ? `?${query}` : ''}`);
}

export async function fetchJobs(): Promise<Job[]> {
  const data = await requestJson<{ jobs: Job[] }>('/api/jobs');
  return data.jobs ?? [];
}

export async function enqueueJobs(payload: CreateJobsPayload): Promise<Job[]> {
  const data = await requestJson<{ jobs: Job[] }>('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return data.jobs ?? [];
}

export async function cancelJob(id: string): Promise<Job> {
  const data = await requestJson<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
  return data.job;
}

export async function retryJob(id: string): Promise<Job> {
  const data = await requestJson<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  });
  return data.job;
}

export async function deleteJob(id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function clearFinishedJobs(): Promise<number> {
  const data = await requestJson<{ removed: number }>('/api/jobs', {
    method: 'DELETE',
  });
  return data.removed ?? 0;
}

export function triggerMediaRefresh(): Promise<RefreshResponse> {
  return requestJson<RefreshResponse>('/api/jellyfin/refresh', {
    method: 'POST',
  });
}
