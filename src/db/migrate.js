import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigration() {
  const schemaPath = path.resolve(__dirname, '../../migrations/001_schema.sql');
  console.log(`[MIGRATE] Reading schema from: ${schemaPath}`);
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const client = await pool.connect();
  try {
    console.log('[MIGRATE] Applying migration 001_schema.sql...');
    await client.query(sql);
    console.log('[MIGRATE] Schema migrated successfully!');
  } catch (err) {
    console.error('[MIGRATE] Error running migration:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Allow direct CLI execution: node src/db/migrate.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigration()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
