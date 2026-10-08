# ApparelFlow ERP — Execution System (Backend)

Enterprise Manufacturing Resource Planning (ERP) platform execution system engineered specifically for commercial garment production facilities. Implements the **Cutting Operations & Gatekeeper Verification Terminal** with mission-critical server-side Role-Based Access Control (RBAC), hard-stop shortage checks, immutable audit logging, and sewing queue isolation.

---

## 1. Architecture Overview

- **Runtime & Framework:** Node.js 20+ (ES Modules) + Express.js
- **Database:** PostgreSQL 16 (AWS RDS db.t3.micro, private VPC)
- **Authentication & RBAC:** Stateless JWT bearer tokens with server-enforced role claims
- **Security:** Helmet HTTP security headers, CORS origin protection, parameter validation with Zod
- **Infrastructure as Code:** Terraform provisioned under `infra/`
- **CI/CD:** Automated GitHub Actions deploying to AWS EC2 via SSH and pm2

```
Browser (React Frontend on EC2 #1)
  │
  ▼ [HTTP Reverse Proxy /api/*]
Nginx on EC2 #1
  │
  ▼ [Port 3000 Private VPC]
Express Backend + PM2 on EC2 #2
  │
  ▼ [Port 5432 Private VPC Security Group]
Amazon RDS PostgreSQL 16
```

---

## 2. Factory Roles & Demo Credentials

The system enforces strict Separation of Duties across three distinct operational personas:

| Role | Email | Password | Allowed Capabilities & Restrictions |
| :--- | :--- | :--- | :--- |
| **Cutting Supervisor** (`cutting_supervisor`) | `supervisor@apparelflow.com` | `Password123!` | Creates cutting batches from recipes, calculates expected parts via recipe multiplier, logs fabric yardage. **Blocked from verifying batches or viewing sewing queue.** |
| **Cutting Verifier** (`cutting_verifier`) | `verifier@apparelflow.com` | `Password123!` | Physical quality checkpoint. Counts cut parts, triggers server-side traffic-light evaluation (GREEN/YELLOW/RED), approves valid batches or rejects with mandatory reason note. **Blocked from creating orders or accessing sewing queue.** |
| **Sewing Supervisor** (`sewing_supervisor`) | `sewing@apparelflow.com` | `Password123!` | Receives verified batches on assembly floor, reviews verifier audit notes & fabric wastage, initiates sewing assembly (`SEWING_STARTED`). **Strictly blocked from unverified, pending, or rejected batches.** |

---

## 3. Relational Schema & State Machine

### Deterministic State Pipeline
```
[CUTTING IN-PROGRESS] ──(Create Order)──> [PENDING_VERIFICATION]
                                                 │
                             ┌───────────────────┴───────────────────┐
                             │                                       │
                  (Reject + Reason Note)                 (All Components GREEN/YELLOW)
                             │                                       │
                             ▼                                       ▼
                        [REJECTED]                              [VERIFIED]
                                                                     │
                                                       (Start Sewing Assembly)
                                                                     │
                                                                     ▼
                                                             [SEWING_STARTED]
```

### Relational Entities (`migrations/001_schema.sql`)
- `users`: Factory accounts with custom enum `user_role`.
- `recipes`: Bill of Materials (BOM) including standard fabric consumption per unit and allowable wastage cap.
- `recipe_components`: Component cut part definitions with pieces per garment.
- `cutting_orders`: Production batches linked to recipe and creator, tracking fabric roll ID and yards.
- `verification_items`: Expected component quantities derived from the recipe multiplier, verified piece counts, and traffic light statuses.
- `verification_logs`: **Immutable server-side audit trail** logging verifier user ID, decision (`APPROVED`/`REJECTED`), timestamp, fabric wastage %, and rejection notes. Protected by PostgreSQL database trigger `logs_immutable` prohibiting any UPDATE or DELETE operations.

---

## 4. Server-Side Security Boundaries & Hard Stop Rules

1. **Gatekeeper Hard Stop:** A batch can **never** be approved if any single component has a shortage (`RED`), is uncounted (`null`), or missing. The backend enforces `422 Unprocessable Entity` and rolls back database transactions.
2. **Server-Side Status Derivation:** Component traffic light flags (`GREEN`, `YELLOW`, `RED`) are calculated exclusively on the server based on `actual_qty` vs `expected_qty`. Client-submitted status flags are ignored.
3. **Sewing Queue Isolation:** `GET /api/sewing/queue` enforces `WHERE o.status = 'VERIFIED'` at the raw SQL query level. Query parameters or client inputs can never expose pending or rejected batches.
4. **Non-Bypassable Identity & Audit Trail:** Verifier ID, timestamps, and decision records are derived directly from the verified JWT server context and PostgreSQL clock, never from request payload bodies.

---

## 5. Getting Started & Setup

### Environment Variables
Copy `.env.example` to `.env` and configure your credentials:

```bash
cp .env.example .env
```

Set the database connection string:
```ini
PORT=3000
NODE_ENV=development
JWT_SECRET=your_secure_32_character_jwt_secret
DATABASE_URL=postgres://afadmin:your_db_password@your-rds-endpoint.amazonaws.com:5432/apparelflow?sslmode=require
```

### Running Migrations & Seed Data
```bash
# Run schema creation (tables, enums, immutable trigger)
npm run migrate

# Seed production recipes and demo user credentials
npm run seed
```

### Starting the Server
```bash
# Development (with Node native file watch)
npm run dev

# Production
npm start
```

---

## 6. Automated Test Suite

Run the full automated test suite verifying all 5 mandatory security rules and RBAC workflows:

```bash
npm test
```

### Test Coverage Checklist:
- [x] **Test 1:** An order with all GREEN components can be approved by an authenticated Verifier.
- [x] **Test 2:** An order containing at least one RED (shortage) component blocks approval and returns 422.
- [x] **Test 3:** Rejecting an order without a reason note is rejected with 422 by backend validation.
- [x] **Test 4:** Non-verifier roles receive 403 Forbidden when attempting verification approval.
- [x] **Test 5:** Unapproved orders never appear in the Sewing Queue database query.
- [x] **RBAC Suite:** Dynamic component multiplier, server-side traffic-light evaluation, sewing status transition guards, and cross-role protection.
