import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test_jwt_secret_key_apparelflow_2026';
process.env.JWT_SECRET = JWT_SECRET;

const createToken = (id, role, full_name = 'Test User') => {
  return jwt.sign({ id, email: `${role}@apparelflow.com`, role, full_name }, JWT_SECRET, { expiresIn: '1h' });
};

const supervisorToken = createToken(1, 'cutting_supervisor', 'Kasun Perera');
const verifierToken = createToken(2, 'cutting_verifier', 'Nadeeka Silva');
const sewingToken = createToken(3, 'sewing_supervisor', 'Dinesh Fernando');

const mockClient = {
  query: vi.fn(),
  release: vi.fn()
};

vi.mock('../src/db/pool.js', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(() => Promise.resolve(mockClient))
  }
}));

const { default: app } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');

describe('ApparelFlow ERP - Workflow & RBAC Domain Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Order Creation & Multiplier Engine (POST /api/orders)', () => {
    it('creates an order with dynamic component multiplier calculations', async () => {
      mockClient.query.mockImplementation((text, params) => {
        if (text === 'BEGIN') return Promise.resolve();
        if (text.includes('SELECT id, recipe_code, name, std_fabric_yards')) {
          return Promise.resolve({
            rows: [{ id: 1, recipe_code: 'REC-BL01', name: 'Casual Blouse', std_fabric_yards: '1.80' }]
          });
        }
        if (text.includes('SELECT id, component_name, pieces_per_garment')) {
          return Promise.resolve({
            rows: [
              { id: 10, component_name: 'Front Body Panel', pieces_per_garment: 1 },
              { id: 11, component_name: 'Sleeves', pieces_per_garment: 2 }
            ]
          });
        }
        if (text.includes('INSERT INTO cutting_orders')) {
          return Promise.resolve({
            rows: [{
              id: 50,
              order_no: 'ORD-5001',
              recipe_id: 1,
              target_qty: 50,
              fabric_roll_id: 'FAB-ROLL-882',
              actual_fabric_yds: '90.00',
              status: 'PENDING_VERIFICATION'
            }]
          });
        }
        if (text.includes('INSERT INTO verification_items')) {
          return Promise.resolve({
            rows: [{ id: 1, order_id: 50, component_id: params[1], expected_qty: params[2], status: null }]
          });
        }
        if (text === 'COMMIT') return Promise.resolve();
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${supervisorToken}`)
        .send({
          recipe_id: 1,
          target_qty: 50,
          fabric_roll_id: 'FAB-ROLL-882',
          actual_fabric_yds: 90
        });

      expect(res.status).toBe(201);
      expect(res.body.order.status).toBe('PENDING_VERIFICATION');
      expect(res.body.items).toHaveLength(2);
      // Multiplier check: 50 garments x 2 sleeves = 100
      expect(res.body.items[1].expected_qty).toBe(100);
    });

    it('blocks Verifier or Sewing Supervisor from creating cutting orders (403 Forbidden)', async () => {
      const resVerifier = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${verifierToken}`)
        .send({ recipe_id: 1, target_qty: 50, fabric_roll_id: 'FAB-1', actual_fabric_yds: 90 });

      expect(resVerifier.status).toBe(403);

      const resSewing = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${sewingToken}`)
        .send({ recipe_id: 1, target_qty: 50, fabric_roll_id: 'FAB-1', actual_fabric_yds: 90 });

      expect(resSewing.status).toBe(403);
    });
  });

  describe('Verification Counts & Server Traffic Light Logic (PUT /api/orders/:id/counts)', () => {
    it('computes GREEN, YELLOW, and RED statuses strictly on server', async () => {
      mockClient.query.mockImplementation((text, params) => {
        if (text === 'BEGIN') return Promise.resolve();
        if (text.includes('SELECT id, status FROM cutting_orders')) {
          return Promise.resolve({ rows: [{ id: 50, status: 'PENDING_VERIFICATION' }] });
        }
        if (text.includes('SELECT expected_qty FROM verification_items')) {
          return Promise.resolve({ rows: [{ expected_qty: 100 }] });
        }
        if (text.includes('UPDATE verification_items')) {
          return Promise.resolve({
            rows: [{
              component_id: params[3],
              actual_qty: params[0],
              status: params[1]
            }]
          });
        }
        if (text === 'COMMIT') return Promise.resolve();
        return Promise.resolve({ rows: [] });
      });

      // Submit actual count: 90 (< 100, should be RED)
      const res = await request(app)
        .put('/api/orders/50/counts')
        .set('Authorization', `Bearer ${verifierToken}`)
        .send({
          counts: [
            { component_id: 1, actual_qty: 90 }
          ]
        });

      expect(res.status).toBe(200);
      expect(res.body.items[0].status).toBe('RED');
    });
  });

  describe('Sewing Handoff Transition (POST /api/sewing/:id/start)', () => {
    it('transitions verified batch to SEWING_STARTED', async () => {
      mockClient.query.mockImplementation((text, params) => {
        if (text === 'BEGIN') return Promise.resolve();
        if (text.includes('SELECT id, order_no, status FROM cutting_orders')) {
          return Promise.resolve({ rows: [{ id: 60, order_no: 'ORD-60', status: 'VERIFIED' }] });
        }
        if (text.includes('UPDATE cutting_orders SET status = \'SEWING_STARTED\'')) {
          return Promise.resolve({ rows: [{ id: 60, status: 'SEWING_STARTED' }] });
        }
        if (text === 'COMMIT') return Promise.resolve();
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app)
        .post('/api/sewing/60/start')
        .set('Authorization', `Bearer ${sewingToken}`);

      expect(res.status).toBe(200);
      expect(res.body.order.status).toBe('SEWING_STARTED');
    });

    it('rejects starting sewing on an unverified order with 409 Conflict', async () => {
      mockClient.query.mockImplementation((text) => {
        if (text === 'BEGIN') return Promise.resolve();
        if (text.includes('SELECT id, order_no, status FROM cutting_orders')) {
          return Promise.resolve({ rows: [{ id: 61, order_no: 'ORD-61', status: 'PENDING_VERIFICATION' }] });
        }
        if (text === 'ROLLBACK') return Promise.resolve();
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app)
        .post('/api/sewing/61/start')
        .set('Authorization', `Bearer ${sewingToken}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/must be 'VERIFIED'/i);
    });
  });
});
