import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test_jwt_secret_key_apparelflow_2026';
process.env.JWT_SECRET = JWT_SECRET;

// Helper to generate test tokens
const createToken = (id, role, full_name = 'Test User') => {
  return jwt.sign({ id, email: `${role}@apparelflow.com`, role, full_name }, JWT_SECRET, { expiresIn: '1h' });
};

const verifierToken = createToken(2, 'cutting_verifier', 'Nadeeka Silva');
const supervisorToken = createToken(1, 'cutting_supervisor', 'Kasun Perera');
const sewingToken = createToken(3, 'sewing_supervisor', 'Dinesh Fernando');

// Mock database pool
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

// Import app after setting env and mocks
const { default: app } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');

describe('ApparelFlow ERP - Gatekeeper & Security Specification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // TEST 1: An order with all GREEN components can be approved by an authenticated Verifier
  it('Test 1: approves an all-GREEN order for an authenticated Verifier', async () => {
    const mockOrder = {
      id: 101,
      order_no: 'ORD-101',
      recipe_id: 1,
      target_qty: 50,
      actual_fabric_yds: '92.50',
      std_fabric_yards: '1.80',
      status: 'PENDING_VERIFICATION'
    };

    const mockItems = [
      { id: 1, order_id: 101, component_id: 1, expected_qty: 50, actual_qty: 50, status: 'GREEN' },
      { id: 2, order_id: 101, component_id: 2, expected_qty: 100, actual_qty: 100, status: 'GREEN' }
    ];

    mockClient.query.mockImplementation((text, params) => {
      if (text === 'BEGIN') return Promise.resolve();
      if (text.includes('SELECT o.*, r.std_fabric_yards')) {
        return Promise.resolve({ rows: [mockOrder] });
      }
      if (text.includes('SELECT * FROM verification_items')) {
        return Promise.resolve({ rows: mockItems });
      }
      if (text.includes('UPDATE cutting_orders')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (text.includes('INSERT INTO verification_logs')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (text === 'COMMIT') return Promise.resolve();
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/api/orders/101/approve')
      .set('Authorization', `Bearer ${verifierToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VERIFIED');
    expect(res.body.wastage_pct).toBeDefined();
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  // TEST 2: An order containing at least one RED (shortage) component blocks approval and returns 422
  it('Test 2: returns 422 when any component is RED (defect shortage)', async () => {
    const mockOrder = {
      id: 102,
      order_no: 'ORD-102',
      recipe_id: 1,
      target_qty: 50,
      actual_fabric_yds: '90.00',
      std_fabric_yards: '1.80',
      status: 'PENDING_VERIFICATION'
    };

    const mockItemsWithShortage = [
      { id: 1, order_id: 102, component_id: 1, expected_qty: 50, actual_qty: 50, status: 'GREEN' },
      { id: 2, order_id: 102, component_id: 2, expected_qty: 100, actual_qty: 95, status: 'RED' } // Shortage!
    ];

    mockClient.query.mockImplementation((text) => {
      if (text === 'BEGIN') return Promise.resolve();
      if (text.includes('SELECT o.*, r.std_fabric_yards')) {
        return Promise.resolve({ rows: [mockOrder] });
      }
      if (text.includes('SELECT * FROM verification_items')) {
        return Promise.resolve({ rows: mockItemsWithShortage });
      }
      if (text === 'ROLLBACK') return Promise.resolve();
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/api/orders/102/approve')
      .set('Authorization', `Bearer ${verifierToken}`);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/shortage or uncounted/i);
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
  });

  // TEST 3: Rejecting an order without a reason note is rejected by backend validation (422)
  it('Test 3: rejects a batch rejection request without a reason note', async () => {
    const res = await request(app)
      .post('/api/orders/103/reject')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send({ rejection_note: '   ' }); // Empty whitespace note

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/mandatory reason note/i);
  });

  // TEST 4: Non-verifier roles receive 403 Forbidden when attempting verification approval
  it('Test 4: returns 403 Forbidden for non-verifier roles on approve attempt', async () => {
    // Supervisor attempting to approve
    const supervisorRes = await request(app)
      .post('/api/orders/104/approve')
      .set('Authorization', `Bearer ${supervisorToken}`);

    expect(supervisorRes.status).toBe(403);
    expect(supervisorRes.body.error).toBe('Forbidden');

    // Sewing Supervisor attempting to approve
    const sewingRes = await request(app)
      .post('/api/orders/104/approve')
      .set('Authorization', `Bearer ${sewingToken}`);

    expect(sewingRes.status).toBe(403);
    expect(sewingRes.body.error).toBe('Forbidden');
  });

  // TEST 5: Unapproved orders never appear in the Sewing Queue database query
  it('Test 5: never lists unapproved orders in the sewing queue query', async () => {
    const executedQueries = [];

    pool.query.mockImplementation((sql) => {
      executedQueries.push(sql);
      if (sql.includes('FROM cutting_orders o')) {
        return Promise.resolve({
          rows: [
            {
              id: 201,
              order_no: 'ORD-201',
              status: 'VERIFIED',
              recipe_name: 'Casual Blouse'
            }
          ]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    // Test with malicious URL tampering attempting to inspect unverified/pending batches
    const res = await request(app)
      .get('/api/sewing/queue?status=PENDING_VERIFICATION')
      .set('Authorization', `Bearer ${sewingToken}`);

    expect(res.status).toBe(200);

    // Verify database query level isolation
    const queueQuery = executedQueries.find((q) => q.includes('FROM cutting_orders o'));
    expect(queueQuery).toBeDefined();
    expect(queueQuery).toContain("WHERE o.status = 'VERIFIED'");
    expect(queueQuery).not.toContain("WHERE o.status = 'PENDING_VERIFICATION'");
    expect(queueQuery).not.toContain("WHERE o.status = 'REJECTED'");

    // Verify non-sewing supervisor cannot access the sewing queue
    const supervisorRes = await request(app)
      .get('/api/sewing/queue')
      .set('Authorization', `Bearer ${supervisorToken}`);
    expect(supervisorRes.status).toBe(403);
  });
});
