import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { applySchemaWithRetry, createPool } from './server/db';
import { createApp } from './server/app';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const port = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

async function setupServer() {
  const pool = createPool();
  await applySchemaWithRetry(pool);
  const app = createApp(pool);

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(port), '0.0.0.0', () => {
    console.log(`DiamondX-A1005 Precision Engine running on port ${port}`);
  });
}

setupServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
