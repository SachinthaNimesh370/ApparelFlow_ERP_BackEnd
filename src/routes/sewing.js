import express from 'express';
import { pool } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = express.Router();

// GET /api/sewing/queue (Sewing Supervisor only)
// STRICT SECURITY REQUIREMENT: Hardcoded WHERE status = 'VERIFIED' at the database level.
// URL parameters must never be allowed to override or leak unapproved orders.
router.get('/queue', authenticate, requireRole('sewing_supervisor'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id,
              o.order_no,
              o.recipe_id,
              o.target_qty,
              o.fabric_roll_id,
              o.actual_fabric_yds,
              o.status,
              o.created_at,
              o.updated_at,
              r.name AS recipe_name,
              r.recipe_code,
              r.category AS recipe_category,
              r.std_fabric_yards,
              r.wastage_cap,
              vl.verifier_id,
              u.full_name AS verifier_name,
              vl.created_at AS verified_at,
              vl.wastage_pct
       FROM cutting_orders o
       JOIN recipes r ON r.id = o.recipe_id
       LEFT JOIN LATERAL (
         SELECT verifier_id, created_at, wastage_pct
         FROM verification_logs
         WHERE order_id = o.id AND decision = 'APPROVED'
         ORDER BY created_at DESC
         LIMIT 1
       ) vl ON true
       LEFT JOIN users u ON u.id = vl.verifier_id
       WHERE o.status = 'VERIFIED'
       ORDER BY o.updated_at DESC`
    );

    // Fetch component items for verified orders so the sewing floor can inspect verified piece counts
    if (rows.length > 0) {
      const orderIds = rows.map((r) => r.id);
      const { rows: items } = await pool.query(
        `SELECT vi.order_id,
                vi.component_id,
                vi.expected_qty,
                vi.actual_qty,
                vi.status,
                rc.component_name
         FROM verification_items vi
         JOIN recipe_components rc ON rc.id = vi.component_id
         WHERE vi.order_id = ANY($1::int[])
         ORDER BY vi.component_id ASC`,
        [orderIds]
      );

      const itemsByOrder = items.reduce((acc, item) => {
        if (!acc[item.order_id]) acc[item.order_id] = [];
        acc[item.order_id].push(item);
        return acc;
      }, {});

      const result = rows.map((order) => ({
        ...order,
        items: itemsByOrder[order.id] || []
      }));

      return res.json(result);
    }

    res.json(rows);
  } catch (err) {
    console.error('Sewing queue fetch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/sewing/:id/start (Sewing Supervisor only)
// Initiates sewing assembly operations: transitions batch from VERIFIED to SEWING_STARTED
router.post('/:id/start', authenticate, requireRole('sewing_supervisor'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [order] } = await client.query(
      'SELECT id, order_no, status FROM cutting_orders WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'VERIFIED') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Cannot start sewing assembly: Order status is '${order.status}', must be 'VERIFIED'`
      });
    }

    const { rows: [updated] } = await client.query(
      "UPDATE cutting_orders SET status = 'SEWING_STARTED', updated_at = now() WHERE id = $1 RETURNING *",
      [order.id]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Sewing assembly successfully initiated',
      order: updated
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Sewing start error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

export default router;
