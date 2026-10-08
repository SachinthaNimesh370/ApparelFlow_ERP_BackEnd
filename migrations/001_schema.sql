-- ApparelFlow ERP Database Schema Migration 001
-- Defines roles, order statuses, relational tables, and immutability audit triggers

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('cutting_supervisor', 'cutting_verifier', 'sewing_supervisor');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE order_status AS ENUM ('PENDING_VERIFICATION', 'REJECTED', 'VERIFIED', 'SEWING_STARTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role user_role NOT NULL,
    full_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recipes (
    id SERIAL PRIMARY KEY,
    recipe_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    std_fabric_yards NUMERIC(6,2) NOT NULL,
    wastage_cap NUMERIC(5,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS recipe_components (
    id SERIAL PRIMARY KEY,
    recipe_id INT REFERENCES recipes(id) ON DELETE CASCADE,
    component_name TEXT NOT NULL,
    pieces_per_garment INT NOT NULL CHECK (pieces_per_garment > 0),
    image_url TEXT
);

CREATE TABLE IF NOT EXISTS cutting_orders (
    id SERIAL PRIMARY KEY,
    order_no TEXT UNIQUE NOT NULL,
    recipe_id INT REFERENCES recipes(id),
    target_qty INT NOT NULL CHECK (target_qty > 0),
    fabric_roll_id TEXT NOT NULL,
    actual_fabric_yds NUMERIC(8,2) NOT NULL CHECK (actual_fabric_yds > 0),
    status order_status NOT NULL DEFAULT 'PENDING_VERIFICATION',
    created_by INT REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification_items (
    id SERIAL PRIMARY KEY,
    order_id INT REFERENCES cutting_orders(id) ON DELETE CASCADE,
    component_id INT REFERENCES recipe_components(id),
    expected_qty INT NOT NULL,
    actual_qty INT,
    status TEXT CHECK (status IN ('GREEN', 'YELLOW', 'RED')),
    UNIQUE(order_id, component_id)
);

CREATE TABLE IF NOT EXISTS verification_logs (
    id SERIAL PRIMARY KEY,
    order_id INT REFERENCES cutting_orders(id),
    verifier_id INT REFERENCES users(id),
    decision TEXT CHECK (decision IN ('APPROVED', 'REJECTED')),
    rejection_note TEXT,
    wastage_pct NUMERIC(6,2),
    created_at TIMESTAMPTZ DEFAULT now(),
    CHECK (decision <> 'REJECTED' OR length(trim(rejection_note)) > 0)
);

-- Immutable audit trail trigger: block updates and deletes on verification_logs
CREATE OR REPLACE FUNCTION no_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'verification_logs is immutable: updates and deletes are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS logs_immutable ON verification_logs;
CREATE TRIGGER logs_immutable BEFORE UPDATE OR DELETE ON verification_logs
    FOR EACH ROW EXECUTE FUNCTION no_mutation();
