import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const parseResult = loginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid input', details: parseResult.error.format() });
  }

  const { email, password } = parseResult.data;

  try {
    const { rows } = await pool.query(
      'SELECT id, email, password_hash, role, full_name FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const tokenPayload = {
      id: user.id,
      email: user.email,
      role: user.role,
      full_name: user.full_name
    };

    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET || 'apparelflow_secret_key_development_fallback',
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: tokenPayload
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, role, full_name, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Auth check error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/demo-users (helpful for the frontend demo credential switcher)
router.get('/demo-users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, role, full_name FROM users ORDER BY id ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('Fetch demo users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
