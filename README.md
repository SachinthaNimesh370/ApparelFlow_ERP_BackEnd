# ApparelFlow ERP — Execution System (Backend)

Enterprise Manufacturing Resource Planning (ERP) platform execution system engineered specifically for commercial garment production facilities. Implements the **Cutting Operations & Gatekeeper Verification Terminal** with mission-critical server-side Role-Based Access Control (RBAC), hard-stop shortage checks, immutable audit logging, and sewing queue isolation.

---

## 1. Technology Stack

| Domain | Technology / Tool | Specification & Purpose |
| :--- | :--- | :--- |
| **Runtime** | **Node.js 20+** | Modern ES Modules (`"type": "module"`), native async/await |
| **Framework** | **Express.js 4** | High-throughput REST API with centralized error handling |
| **Database** | **PostgreSQL 16** | Amazon RDS (`db.t3.micro`), private VPC subnet |
| **Data Access** | **node-postgres (`pg`)** | Connection pool with explicit ACID transactions & `FOR UPDATE` row locks |
| **Validation** | **Zod 3** | Defensive schema validation, numeric coercion guards, string sanitization |
| **Authentication** | **JWT (`jsonwebtoken`)** | Stateless cryptographic tokens with tamper-proof role claims |
| **Password Security** | **bcrypt** | Adaptive hashing with 10 salt rounds |
| **HTTP Security** | **Helmet & CORS** | Secure HTTP headers, strict origin whitelisting |
| **Test Automation** | **Vitest & Supertest** | 10 passing unit and integration tests verifying domain security rules |
| **Process Manager** | **PM2** | Zero-downtime clustering, process recovery, environment injection |
| **IaC** | **Terraform** | Automated AWS provisioning (VPC, Security Groups, EC2, RDS, Key Pairs) |
| **CI/CD** | **GitHub Actions** | Automated regression testing, SSH synchronization via rsync |

---

## 2. Infrastructure Architecture & Network Flow

```
[ Web Browser (React Client) ]
              │
              ▼ (Port 80 HTTP / Reverse Proxy)
  [ Nginx on AWS EC2 Frontend (13.233.146.254) ]
              │
              │  proxy_pass /api/*  (Port 3000 Private VPC)
              ▼
  [ Express.js + PM2 on AWS EC2 Backend (15.207.71.143) ]
              │
              │  Port 5432 (Private DB Subnet / Security Group)
              ▼
  [ Amazon RDS PostgreSQL 16 (apparelflow-db) ]
```

---

## 3. Entity-Relationship (ER) Diagram

The system operates on 6 normalized relational entities with foreign keys, checks, enums, and an immutable audit trigger:

```mermaid
erDiagram
    users ||--o{ cutting_orders : "creates"
    users ||--o{ verification_logs : "signs off"
    recipes ||--|{ recipe_components : "contains"
    recipes ||--o{ cutting_orders : "instantiated by"
    cutting_orders ||--|{ verification_items : "composed of"
    recipe_components ||--o{ verification_items : "specifies"
    cutting_orders ||--o{ verification_logs : "audited by"

    users {
        int id PK
        string email UK
        string password_hash
        user_role role "ENUM('cutting_supervisor', 'cutting_verifier', 'sewing_supervisor')"
        string full_name
        timestamptz created_at
    }

    recipes {
        int id PK
        string recipe_code UK "e.g. REC-BL01, REC-CT02"
        string name "e.g. Casual Blouse, Crop Top"
        string category
        numeric std_fabric_yards "Standard consumption per unit"
        numeric wastage_cap "Allowable wastage threshold %"
    }

    recipe_components {
        int id PK
        int recipe_id FK
        string component_name "e.g. Sleeves, Collar, Cuffs"
        int pieces_per_garment "Multiplier factor"
        string image_url
    }

    cutting_orders {
        int id PK
        string order_no UK "e.g. ORD-202610-123"
        int recipe_id FK
        int target_qty "Planned garment units"
        string fabric_roll_id "Fabric lot identifier"
        numeric actual_fabric_yds "Physical yards drawn"
        order_status status "ENUM('PENDING_VERIFICATION','REJECTED','VERIFIED','SEWING_STARTED')"
        int created_by FK
        timestamptz created_at
        timestamptz updated_at
    }

    verification_items {
        int id PK
        int order_id FK
        int component_id FK
        int expected_qty "target_qty * pieces_per_garment"
        int actual_qty "Physical count by Verifier"
        string status "CHECK('GREEN', 'YELLOW', 'RED')"
    }

    verification_logs {
        int id PK
        int order_id FK
        int verifier_id FK "Derived strictly from JWT"
        string decision "CHECK('APPROVED', 'REJECTED')"
        string rejection_note "Mandatory on REJECTED"
        numeric wastage_pct "Calculated fabric variance %"
        timestamptz created_at "Server timestamp (IMMUTABLE)"
    }
```

### Relational Integrity & Immutability Trigger
- **Immutable Audit Trail:** A PostgreSQL trigger `logs_immutable` enforces that records in `verification_logs` cannot be modified or deleted:
  ```sql
  CREATE OR REPLACE FUNCTION no_mutation() RETURNS trigger AS $$
  BEGIN
      RAISE EXCEPTION 'verification_logs is immutable: updates and deletes are prohibited';
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER logs_immutable BEFORE UPDATE OR DELETE ON verification_logs
      FOR EACH ROW EXECUTE FUNCTION no_mutation();
  ```
- **Conditional Mandatory Rejection:** Database-level constraint:
  ```sql
  CHECK (decision <> 'REJECTED' OR length(trim(rejection_note)) > 0)
  ```

---

## 4. Manufacturing State Machine Architecture

The manufacturing lifecycle is modeled as a deterministic, server-enforced state machine:

```mermaid
stateDiagram-v2
    [*] --> PENDING_VERIFICATION : Supervisor Creates Batch (POST /api/orders)
    
    state PENDING_VERIFICATION {
        [*] --> PhysicalCounting : Bundles Arrive at QC Station
        PhysicalCounting --> TrafficLightEvaluation : Server Evaluates Counts
        TrafficLightEvaluation --> CheckGatekeeper : Verifier Decides
    }
    
    PENDING_VERIFICATION --> REJECTED : Defect / Shortage (Mandatory Note)
    PENDING_VERIFICATION --> VERIFIED : All Components GREEN/YELLOW (Pass QC)
    
    REJECTED --> [*] : Returned to Cutting Floor for Re-cut
    
    VERIFIED --> SEWING_STARTED : Sewing Floor Releases Line (POST /api/sewing/:id/start)
    SEWING_STARTED --> [*] : Assembly in Progress
```

---

## 5. Factory Personas & Role-Based Access Control (RBAC)

The system enforces strict Separation of Duties across three distinct operational personas:

| Operational Persona | Role Key | Test Credentials | Capabilities & Permissions | Strict System Restrictions |
| :--- | :--- | :--- | :--- | :--- |
| **Cutting Supervisor** | `cutting_supervisor` | `supervisor@apparelflow.com`<br>`Password123!` | • Selects garment recipes<br>• Calculates piece counts via recipe multiplier<br>• Enters fabric roll & yards<br>• Creates cutting orders | ⛔ **BLOCKED** from approving/rejecting batches (`403 Forbidden`).<br>⛔ **BLOCKED** from viewing Sewing Queue (`403 Forbidden`). |
| **Cutting Verifier** | `cutting_verifier` | `verifier@apparelflow.com`<br>`Password123!` | • Physical quality checkpoint<br>• Counts component cut parts<br>• Server evaluates GREEN/YELLOW/RED<br>• Approves batches or rejects with note | ⛔ **BLOCKED** from creating orders (`403 Forbidden`).<br>⛔ **BLOCKED** from accessing Sewing Queue (`403 Forbidden`). |
| **Sewing Supervisor** | `sewing_supervisor` | `sewing@apparelflow.com`<br>`Password123!` | • Receives verified batches on assembly floor<br>• Inspects verifier audit logs & fabric wastage %<br>• Initiates sewing assembly (`SEWING_STARTED`) | ⛔ **STRICTLY BLOCKED** from unverified, pending, or rejected cutting orders. |

---

## 6. Server-Side Security Rules & Hard Stop Safeguards

Security is enforced at the server API and database transaction levels rather than relying on the frontend:

1. **Gatekeeper Hard Stop:**
   - In `POST /api/orders/:id/approve`, the server queries `verification_items`.
   - If any component has `status === 'RED'`, `actual_qty === null`, or is missing, the backend aborts the transaction with `422 Unprocessable Entity`.
2. **Server-Side Status Derivation (No Client Spoofing):**
   - The client never submits status strings. In `PUT /api/orders/:id/counts`, the server compares `actual_qty` against `expected_qty`:
     - `actual == expected` &rarr; `GREEN` (Exact Match)
     - `actual > expected` &rarr; `YELLOW` (Excess Surplus)
     - `actual < expected` &rarr; `RED` (Shortage Defect)
3. **Sewing Queue Isolation:**
   - `GET /api/sewing/queue` hardcodes `WHERE o.status = 'VERIFIED'` at the raw SQL query level. URL parameter manipulation can never leak unapproved batches.
4. **JWT Context Trust Boundary:**
   - Verifier IDs and creator IDs are extracted strictly from `req.user.id` decoded from the cryptographic JWT, never trusted from the client payload.

---

## 7. REST API Endpoints Specification

| Method | Endpoint | Authorized Role | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/login` | Public | Authenticates operator with email & password, returns JWT token & user profile |
| `GET` | `/api/auth/me` | Authenticated | Validates active session and retrieves user profile |
| `GET` | `/api/recipes` | Authenticated | Lists pre-seeded production recipes and Bill of Materials components |
| `GET` | `/api/recipes/:id` | Authenticated | Retrieves detailed recipe specification with components and consumption metrics |
| `GET` | `/api/orders` | Supervisor, Verifier | Retrieves cutting orders (Sewing Supervisor blocked with `403`) |
| `GET` | `/api/orders/:id` | Authenticated | Retrieves full order details with verification items and audit logs |
| `POST` | `/api/orders` | `cutting_supervisor` | Creates new cutting batch and derives expected parts via multiplier |
| `PUT` | `/api/orders/:id/counts` | `cutting_verifier` | Updates component piece counts; server derives traffic light statuses |
| `POST` | `/api/orders/:id/approve` | `cutting_verifier` | Hard-stop gatekeeper: approves batch if all GREEN/YELLOW, logs audit record |
| `POST` | `/api/orders/:id/reject` | `cutting_verifier` | Rejects batch with mandatory reason note, returning to cutting floor |
| `GET` | `/api/sewing/queue` | `sewing_supervisor` | Retrieves verified batches released for sewing assembly |
| `POST` | `/api/sewing/:id/start` | `sewing_supervisor` | Initiates assembly line, transitioning batch to `SEWING_STARTED` |

---

## 8. Automated Test Suite (Vitest)

Run the full automated test suite verifying all 5 mandatory security rules and domain specifications:

```bash
npm test
```

### Test Coverage Checklist:
- [x] **Test 1:** An order with all GREEN components can be approved by an authenticated Verifier (`200 OK`).
- [x] **Test 2:** An order containing at least one RED (shortage) component blocks approval and returns `422 Unprocessable Entity`.
- [x] **Test 3:** Rejecting an order without a reason note is rejected by backend validation (`422 Unprocessable Entity`).
- [x] **Test 4:** Non-verifier roles receive `403 Forbidden` when attempting verification approval.
- [x] **Test 5:** Unapproved orders never appear in the Sewing Queue database query (`WHERE o.status = 'VERIFIED'`).
- [x] **Domain RBAC Suite:** Dynamic component multiplier derivation, server-side traffic-light evaluation, sewing status transition guards, and cross-role protection.

*(All 10 tests passing).*

---

## 9. Local Setup & Installation

### Prerequisites
- Node.js 20+
- PostgreSQL 16+

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Configure Environment Variables
Copy `.env.example` to `.env`:
```ini
PORT=3000
NODE_ENV=development
JWT_SECRET=your_secure_32_character_jwt_secret
DATABASE_URL=postgres://afadmin:Password123!@localhost:5432/apparelflow
```

### Step 3: Run Database Migrations & Seeds
```bash
# Execute schema migration (enums, tables, constraints, immutability trigger)
npm run migrate

# Seed production recipes (Casual Blouse, Crop Top) and demo users
npm run seed
```

### Step 4: Start the Server
```bash
# Development (with Node native file watch)
npm run dev

# Production
npm start
```
