import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const isProduction = process.env.NODE_ENV === 'production';
const connectionString = process.env.DATABASE_URL;

let poolConfig = {};

if (connectionString) {
  const needsSsl = connectionString.includes('sslmode=require') || isProduction || process.env.PGSSL === 'true';
  poolConfig = {
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : false
  };
} else {
  poolConfig = {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'apparelflow',
    user: process.env.PGUSER || 'afadmin',
    password: process.env.PGPASSWORD || 'ChangeMe_123',
    ssl: process.env.PGSSL === 'true' || isProduction ? { rejectUnauthorized: false } : false
  };
}

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

export const query = (text, params) => pool.query(text, params);
export const getClient = () => pool.connect();
