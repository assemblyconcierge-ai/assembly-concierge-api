// Assembly Concierge — Phase 1 Server Entry Point
// Loads .env, initialises database, starts Express

import 'dotenv/config';
import { createDatabase } from './db/database.js';
import { createApp } from './app.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

createDatabase()
  .then((db) => {
    const app = createApp(db);
    app.listen(PORT, () => {
      console.log(`[AC-API] Assembly Concierge API running on port ${PORT}`);
      console.log(`[AC-API] Health: http://localhost:${PORT}/health`);
      console.log(`[AC-API] Environment: ${process.env.NODE_ENV ?? 'development'}`);
    });
  })
  .catch((err) => {
    console.error('[AC-API] Failed to start:', err);
    process.exit(1);
  });
