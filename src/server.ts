import type { ServerResponse } from 'node:http';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { loadConfig } from './config';
import { refreshMediaTargets } from './jellyfin';
import { JobQueueManager } from './queue';
import { listDriveDirectories } from './rclone';
import { sanitizeRelativePath } from './security';
import { JobStore, verifyWritableDirectory } from './store';
import type { CreateJobsRequest, Job } from './types';

async function main(): Promise<void> {
  const config = loadConfig();
  await verifyWritableDirectory(config.dataDir, 'DATA_DIR');
  await verifyWritableDirectory(config.stagingDir, 'STAGING_DIR');

  const store = new JobStore(config.dataDir);
  const queue = new JobQueueManager(config, store);
  await queue.init();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  const publicDir = path.resolve(__dirname, '../../public');
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/config', async () => {
    const disk = await queue.getDiskStatus().catch(() => ({ freeBytes: 0, totalBytes: 0 }));
    return {
      rcloneRoot: config.rcloneRoot,
      jellyfinConfigured: Boolean(config.jellyfinUrl && config.jellyfinApiKey),
      rcloneRcConfigured: Boolean(config.rcloneRcUrl),
      maxConcurrentJobs: config.maxConcurrentJobs,
      minFreeDiskBytes: config.minFreeDiskBytes,
      disk,
    };
  });

  app.get<{ Querystring: { path?: string; refresh?: string } }>(
    '/api/folders',
    async (request, reply) => {
      try {
        const relPath = sanitizeRelativePath(request.query.path);
        const bypassCache = request.query.refresh === '1' || request.query.refresh === 'true';
        const folders = await listDriveDirectories(config, relPath, bypassCache);
        return {
          root: config.rcloneRoot,
          path: relPath,
          folders,
        };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get('/api/jobs', async () => ({
    jobs: queue.listJobs(),
  }));

  app.post<{ Body: CreateJobsRequest }>('/api/jobs', async (request, reply) => {
    try {
      const jobs = await queue.enqueueJobs(request.body);
      return reply.code(201).send({ jobs });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (request, reply) => {
    try {
      const job = await queue.cancelJob(request.params.id);
      return { job };
    } catch (err) {
      const msg = (err as Error).message;
      return reply.code(msg === 'Job not found' ? 404 : 400).send({ error: msg });
    }
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request, reply) => {
    try {
      const job = await queue.retryJob(request.params.id);
      return { job };
    } catch (err) {
      const msg = (err as Error).message;
      return reply.code(msg === 'Job not found' ? 404 : 400).send({ error: msg });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    try {
      await queue.deleteJob(request.params.id);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      return reply.code(msg === 'Job not found' ? 404 : 400).send({ error: msg });
    }
  });

  app.delete('/api/jobs', async () => {
    const removed = await queue.clearFinished();
    return { removed };
  });

  app.post('/api/jellyfin/refresh', async (_request, reply) => {
    if (!config.jellyfinUrl && !config.rcloneRcUrl) {
      return reply.code(400).send({ error: 'Neither Jellyfin nor rclone RC is configured' });
    }
    const result = await refreshMediaTargets(config);
    return result;
  });

  const sseClients = new Set<ServerResponse>();
  let shuttingDown = false;

  app.get('/api/events', (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    if (shuttingDown) {
      res.writeHead(503);
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sseClients.add(res);

    const sendEvent = (event: string, data: unknown) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('snapshot', queue.listJobs());

    const onJobUpdate = (job: Job) => sendEvent('job', job);
    const onJobsChanged = (jobs: Job[]) => sendEvent('snapshot', jobs);

    queue.on('job-update', onJobUpdate);
    queue.on('jobs-changed', onJobsChanged);

    const keepalive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, 15_000);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepalive);
      sseClients.delete(res);
      queue.off('job-update', onJobUpdate);
      queue.off('jobs-changed', onJobsChanged);
    };

    request.raw.on('close', cleanup);
    res.on('close', cleanup);
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info('Shutting down drive-downloader...');
    for (const res of sseClients) {
      if (!res.writableEnded) {
        res.end();
      }
    }
    sseClients.clear();
    await queue.shutdown();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
