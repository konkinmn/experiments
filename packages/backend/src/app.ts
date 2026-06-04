import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health.js';
import { timelineAnalyzerRoutes } from './routes/timeline-analyzer.js';
import { datasetRoutes } from './routes/dataset.js';
import { caseBrowserRoutes } from './routes/case-browser.js';
import { queueAnalyserRoutes } from './routes/queue-analyser.js';
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
  app.register(datasetRoutes, { prefix: '/api/datasets' });
  app.register(caseBrowserRoutes, { prefix: '/api/case-browser' });
  app.register(queueAnalyserRoutes, { prefix: '/api/queue-analyser' });

  app.addHook('onClose', async () => {
    await closePool();
  });

  return app;
}
