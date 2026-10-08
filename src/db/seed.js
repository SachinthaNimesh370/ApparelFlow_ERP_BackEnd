import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import { pool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runSeed() {
  const seedPath = path.resolve(__dirname, '../../migrations/002_seed.sql');
  console.log(`[SEED] Reading seed from: ${seedPath}`);
  const sql = fs.readFileSync(seedPath, 'utf8');

  const client = await pool.connect();
  try {
    console.log('[SEED] Applying seed 002_seed.sql...');
    await client.query(sql);
    console.log('[SEED] Database seeded successfully!');
  } catch (err) {
    console.error('[SEED] Error running seed:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Allow direct CLI execution: node src/db/seed.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSeed()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
