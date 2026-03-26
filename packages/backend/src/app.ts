import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health.js';
import { timelineAnalyzerRoutes } from './routes/timeline-analyzer.js';
import { disputePipelineRoutes } from './routes/dispute-pipeline.js';
import { datasetRoutes } from './routes/dataset.js';
import { closePool } from './services/db.js';

export function buildApp() {
  const app = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
        },
      },
    },
  });

  // Register CORS
  app.register(cors, {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5176',
    credentials: true,
  });

  // Register routes
  app.register(healthRoutes);
  app.register(timelineAnalyzerRoutes, { prefix: '/api/timeline-analyzer' });
  app.register(disputePipelineRoutes, { prefix: '/api/dispute-pipeline' });
  app.register(datasetRoutes, { prefix: '/api/dataset' });

  app.addHook('onClose', async () => {
    await closePool();
  });

  return app;
}
