# AI Usage & Engineering Judgment Protocol Report

**Project:** ApparelFlow ERP Execution System (Backend)  
**Module:** Production Batch Verification & Sewing Queue Gate (Full-Stack RBAC)  
**Candidate / Engineer:** Webtezza Software Engineering Intern Assessment  

---

## 1. Tools & Prompting

During the development of the ApparelFlow ERP backend, AI engineering assistants were utilized for rapid scaffolding, schema drafting, and test boilerplate generation:

- **AI Tools Employed:**
  - **Antigravity AI / Claude 3.5 Sonnet / GPT-4o:** Used for drafting initial Express boilerplate, relational SQL DDL scripts, and mock generation for Vitest/Supertest.
- **Tasks & Prompt Workflows:**
  - *Schema Drafting:* Prompted to generate a PostgreSQL schema matching the Bill of Materials and manufacturing state machine specifications.
  - *API Scaffolding:* Prompted to scaffold Express route handlers for order creation, component counting, approval gates, and sewing queues.
  - *Automated Testing:* Prompted to construct Vitest/Supertest assertions covering the 5 core domain validation rules.

---

## 2. Flawed / Broken AI Code Identified

Blindly trusting raw AI-generated output in production manufacturing applications introduces catastrophic security and operational flaws. Two specific high-severity flaws were detected and intercepted:

### Flaw 1: Client-Controlled Status Flags & Tamperable Verification Status
* **The AI Vulnerability:** When initially scaffolding the component count update endpoint (`PUT /orders/:id/counts`), the generated AI handler accepted the component status directly from the client payload:
  ```javascript
  // BUGGY AI CODE
  const { counts } = req.body; // e.g. [{ component_id: 1, actual_qty: 10, status: "GREEN" }]
  for (const item of counts) {
    await client.query(
      "UPDATE verification_items SET actual_qty = $1, status = $2 WHERE order_id = $3 AND component_id = $4",
      [item.actual_qty, item.status, req.params.id, item.component_id]
    );
  }
  ```
* **The Production Hazard:** An operator or malicious script could bypass physical factory counting by submitting `{ actual_qty: 0, status: "GREEN" }`. The server would naively store `GREEN` despite a massive shortage defect, allowing incomplete bundles to reach the sewing line and causing assembly line stoppages.

### Flaw 2: Leaky Query Parameter Filter in Sewing Queue Endpoint
* **The AI Vulnerability:** In the sewing queue route (`GET /api/sewing/queue`), the AI model introduced dynamic query filtering based on client request parameters:
  ```javascript
  // BUGGY AI CODE
  const statusFilter = req.query.status || 'VERIFIED';
  const { rows } = await pool.query(
    `SELECT * FROM cutting_orders WHERE status = $1`, [statusFilter]
  );
  ```
* **The Production Hazard:** A sewing supervisor could simply append `?status=PENDING_VERIFICATION` or `?status=REJECTED` to the URL and inspect unapproved cutting batches or rejected fabric rolls, directly violating the ERP separation of duties and query isolation specification.

---

## 3. Human Engineering Refactoring

To resolve these defects and harden the codebase for enterprise deployment, the following manual refactors were implemented:

1. **Server-Side Status Derivation:**
   - Stripped all client-provided status fields from `req.body`.
   - The backend explicitly queries `expected_qty` from the database and derives the traffic-light status deterministically:
     ```javascript
     let status = 'GREEN';
     if (actualQty < expectedQty) {
       status = 'RED'; // Shortage defect
     } else if (actualQty > expectedQty) {
       status = 'YELLOW'; // Surplus
     }
     ```
2. **Hard-Coded Sewing Query Isolation:**
   - Eliminated any dynamic parameter resolution for the sewing queue status filter.
   - The query hardcodes `WHERE o.status = 'VERIFIED'` at the database level, preventing any URL query tampering from leaking non-verified orders.
3. **Database Concurrency & Row Locking:**
   - Wrapped the approval and rejection workflows in explicit PostgreSQL transactions with `SELECT ... FOR UPDATE` row locks to prevent race conditions where two simultaneous requests could approve an order twice or approve while counts were being edited.
4. **Immutable Audit Enforcement:**
   - Implemented a PostgreSQL PL/pgSQL trigger (`logs_immutable`) raising an exception on any attempt to `UPDATE` or `DELETE` records in `verification_logs`.

---

## 4. Defensive Architecture & API Protection

The architecture enforces security boundaries at the API and database levels rather than relying on frontend visibility:

- **Server-Side RBAC Middleware:**
  - Protected endpoints utilize `requireRole('cutting_supervisor')`, `requireRole('cutting_verifier')`, and `requireRole('sewing_supervisor')`.
  - Attempting to access an unauthorized endpoint returns `403 Forbidden` immediately before database access.
- **Server-Side Hard Stop Validation:**
  - In `POST /api/orders/:id/approve`, before any state mutation can occur, the backend executes an exhaustive query over `verification_items`. If `items.length === 0` or if any component contains `actual_qty === null` or `status === 'RED'`, the transaction executes an immediate `ROLLBACK` and responds with `422 Unprocessable Entity`.
- **JWT Context Trust Boundary:**
  - Verifier IDs for audit logs are extracted exclusively from the decoded JWT session (`req.user.id`), rejecting any user IDs sent in the client JSON body.
- **Strict Input Sanitization:**
  - Zod schemas validate that piece counts, target quantities, and fabric yardages are strictly non-negative integers or positive floats, blocking negative numbers and invalid strings.
