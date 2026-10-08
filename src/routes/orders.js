import express from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Schema validations
const createOrderSchema = z.object({
  recipe_id: z.number().int().positive(),
  target_qty: z.number().int().positive(),
  fabric_roll_id: z.string().trim().min(1, 'Fabric Roll ID is required'),
  actual_fabric_yds: z.number().positive('Fabric yards must be greater than 0')
});

const updateCountsSchema = z.object({
  counts: z.array(
    z.object({
      component_id: z.number().int().positive(),
      actual_qty: z.number().int().nonnegative('Piece count cannot be negative')
    })
  ).min(1, 'At least one component count is required')
});

const rejectOrderSchema = z.object({
  rejection_note: z.string().trim().min(1, 'Rejection note is mandatory')
});

// POST /api/orders (Cutting Supervisor only)
router.post('/', authenticate, requireRole('cutting_supervisor'), async (req, res) => {
  const parseResult = createOrderSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid order input', details: parseResult.error.format() });
  }

  const { recipe_id, target_qty, fabric_roll_id, actual_fabric_yds } = parseResult.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify recipe exists and fetch components
    const { rows: recipeRows } = await client.query(
      'SELECT id, recipe_code, name, std_fabric_yards, wastage_cap FROM recipes WHERE id = $1',
      [recipe_id]
    );

    if (recipeRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recipe not found' });
    }

    const { rows: components } = await client.query(
      'SELECT id, component_name, pieces_per_garment FROM recipe_components WHERE recipe_id = $1 ORDER BY id ASC',
      [recipe_id]
    );

    if (components.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Recipe has no components configured' });
    }

    // Generate unique order number e.g. ORD-20261008-1234
    const orderNo = `ORD-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

    const { rows: orderRows } = await client.query(
      `INSERT INTO cutting_orders (
        order_no, recipe_id, target_qty, fabric_roll_id, actual_fabric_yds, status, created_by
      ) VALUES ($1, $2, $3, $4, $5, 'PENDING_VERIFICATION', $6)
      RETURNING *`,
      [orderNo, recipe_id, target_qty, fabric_roll_id, actual_fabric_yds, req.user.id]
    );

    const createdOrder = orderRows[0];

    // Compute multiplier & insert verification items
    const verificationItems = [];
    for (const comp of components) {
      const expectedQty = target_qty * comp.pieces_per_garment;
      const { rows: itemRows } = await client.query(
        `INSERT INTO verification_items (order_id, component_id, expected_qty, actual_qty, status)
         VALUES ($1, $2, $3, NULL, NULL)
         RETURNING *`,
        [createdOrder.id, comp.id, expectedQty]
      );
      verificationItems.push({
        ...itemRows[0],
        component_name: comp.component_name,
        pieces_per_garment: comp.pieces_per_garment
      });
    }

    await client.query('COMMIT');

    res.status(201).json({
      order: createdOrder,
      items: verificationItems
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Order creation error:', err);
    res.status(500).json({ error: 'Failed to create cutting order' });
  } finally {
    client.release();
  }
});

// GET /api/orders (Supervisors and Verifiers)
// Sewing Supervisor is strictly blocked from seeing unverified/pending/rejected cutting orders
router.get('/', authenticate, async (req, res) => {
  if (req.user.role === 'sewing_supervisor') {
    return res.status(403).json({
      error: 'Forbidden: Sewing supervisors must access orders exclusively through the Sewing Queue'
    });
  }

  try {
    const { status } = req.query;
    let queryText = `
      SELECT o.*,
             r.name AS recipe_name,
             r.recipe_code,
             u.full_name AS created_by_name
      FROM cutting_orders o
      JOIN recipes r ON r.id = o.recipe_id
      JOIN users u ON u.id = o.created_by
    `;
    const params = [];

    if (status) {
      params.push(status);
      queryText += ` WHERE o.status = $1`;
    }

    queryText += ` ORDER BY o.created_at DESC`;

    const { rows } = await pool.query(queryText, params);
    res.json(rows);
  } catch (err) {
    console.error('Fetch orders error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/orders/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows: orderRows } = await pool.query(
      `SELECT o.*,
              r.name AS recipe_name,
              r.recipe_code,
              r.std_fabric_yards,
              r.wastage_cap,
              u.full_name AS created_by_name
       FROM cutting_orders o
       JOIN recipes r ON r.id = o.recipe_id
       JOIN users u ON u.id = o.created_by
       WHERE o.id = $1`,
      [req.params.id]
    );

    if (orderRows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderRows[0];

    // Sewing Supervisor isolation: strictly blocked from unverified/pending/rejected orders
    if (req.user.role === 'sewing_supervisor' && order.status !== 'VERIFIED' && order.status !== 'SEWING_STARTED') {
      return res.status(403).json({ error: 'Forbidden: Order is not verified for sewing floor access' });
    }

    const { rows: items } = await pool.query(
      `SELECT vi.*,
              rc.component_name,
              rc.pieces_per_garment,
              rc.image_url
       FROM verification_items vi
       JOIN recipe_components rc ON rc.id = vi.component_id
       WHERE vi.order_id = $1
       ORDER BY rc.id ASC`,
      [order.id]
    );

    const { rows: logs } = await pool.query(
      `SELECT vl.*, u.full_name AS verifier_name
       FROM verification_logs vl
       JOIN users u ON u.id = vl.verifier_id
       WHERE vl.order_id = $1
       ORDER BY vl.created_at DESC`,
      [order.id]
    );

    res.json({
      ...order,
      items,
      logs
    });
  } catch (err) {
    console.error('Fetch order detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/orders/:id/counts (Cutting Verifier only)
// Evaluates GREEN/YELLOW/RED strictly on server
router.put('/:id/counts', authenticate, requireRole('cutting_verifier'), async (req, res) => {
  const parseResult = updateCountsSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid counts payload', details: parseResult.error.format() });
  }

  const { counts } = parseResult.data;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: orderRows } = await client.query(
      'SELECT id, status FROM cutting_orders WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );

    if (orderRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderRows[0];
    if (order.status !== 'PENDING_VERIFICATION') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only pending verification orders can have counts updated' });
    }

    const updatedItems = [];

    for (const item of counts) {
      // Fetch expected quantity
      const { rows: currentItemRows } = await client.query(
        'SELECT expected_qty FROM verification_items WHERE order_id = $1 AND component_id = $2',
        [order.id, item.component_id]
      );

      if (currentItemRows.length === 0) {
        continue;
      }

      const expectedQty = currentItemRows[0].expected_qty;
      const actualQty = item.actual_qty;

      // Server-side traffic light derivation:
      // GREEN: actual == expected
      // YELLOW: actual > expected
      // RED: actual < expected (shortage)
      let status = 'GREEN';
      if (actualQty < expectedQty) {
        status = 'RED';
      } else if (actualQty > expectedQty) {
        status = 'YELLOW';
      }

      const { rows: updated } = await client.query(
        `UPDATE verification_items
         SET actual_qty = $1, status = $2
         WHERE order_id = $3 AND component_id = $4
         RETURNING *`,
        [actualQty, status, order.id, item.component_id]
      );

      if (updated.length > 0) {
        updatedItems.push(updated[0]);
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Counts updated successfully', items: updatedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Count update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/orders/:id/approve (Cutting Verifier only - Hard Stop Gatekeeper)
router.post('/:id/approve', authenticate, requireRole('cutting_verifier'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [order] } = await client.query(
      `SELECT o.*, r.std_fabric_yards
       FROM cutting_orders o
       JOIN recipes r ON r.id = o.recipe_id
       WHERE o.id = $1 FOR UPDATE`,
      [req.params.id]
    );

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'PENDING_VERIFICATION') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Invalid state transition: order is not in PENDING_VERIFICATION' });
    }

    const { rows: items } = await client.query(
      'SELECT * FROM verification_items WHERE order_id = $1',
      [order.id]
    );

    const bad = items.length === 0 ||
      items.some(i => i.actual_qty === null || i.actual_qty === undefined || i.status === 'RED');

    if (bad) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'Shortage or uncounted component detected: batch cannot enter Sewing Queue'
      });
    }

    const expectedFabric = Number(order.target_qty) * Number(order.std_fabric_yards);
    const actualFabric = Number(order.actual_fabric_yds);
    const wastage = ((actualFabric - expectedFabric) / expectedFabric) * 100;
    const wastageFormatted = Number(wastage.toFixed(2));

    await client.query(
      "UPDATE cutting_orders SET status = 'VERIFIED', updated_at = now() WHERE id = $1",
      [order.id]
    );

    // Verifier ID strictly derived from authenticated JWT session, never from request body
    await client.query(
      `INSERT INTO verification_logs (order_id, verifier_id, decision, wastage_pct)
       VALUES ($1, $2, 'APPROVED', $3)`,
      [order.id, req.user.id, wastageFormatted]
    );

    await client.query('COMMIT');

    res.json({
      status: 'VERIFIED',
      wastage_pct: wastageFormatted,
      message: 'Batch successfully verified and released to Sewing Queue'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Approval error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /api/orders/:id/reject (Cutting Verifier only)
router.post('/:id/reject', authenticate, requireRole('cutting_verifier'), async (req, res) => {
  const parseResult = rejectOrderSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(422).json({
      error: 'Rejection requires a mandatory reason note',
      details: parseResult.error.format()
    });
  }

  const { rejection_note } = parseResult.data;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [order] } = await client.query(
      'SELECT * FROM cutting_orders WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'PENDING_VERIFICATION') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Invalid state transition: order is not in PENDING_VERIFICATION' });
    }

    await client.query(
      "UPDATE cutting_orders SET status = 'REJECTED', updated_at = now() WHERE id = $1",
      [order.id]
    );

    // Insert into immutable verification logs
    await client.query(
      `INSERT INTO verification_logs (order_id, verifier_id, decision, rejection_note)
       VALUES ($1, $2, 'REJECTED', $3)`,
      [order.id, req.user.id, rejection_note]
    );

    await client.query('COMMIT');

    res.json({
      status: 'REJECTED',
      rejection_note,
      message: 'Batch rejected and returned to Cutting Supervisor with note'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Rejection error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

export default router;
