-- ApparelFlow ERP Database Seed Migration 002
-- Seeds initial demo users and the two mandatory production recipes (Casual Blouse & Crop Top)

-- 1. Demo Users (Password: Password123!)
-- Hash generated using bcrypt with salt rounds = 10
INSERT INTO users (email, password_hash, role, full_name)
VALUES
  ('supervisor@apparelflow.com', '$2b$10$pP0aLNRV.hUuO6AbMyGWqODgRUI6AZa9bGzTpFScZWuRkf58UoxKm', 'cutting_supervisor', 'Kasun Perera (Cutting Supervisor)'),
  ('verifier@apparelflow.com', '$2b$10$pP0aLNRV.hUuO6AbMyGWqODgRUI6AZa9bGzTpFScZWuRkf58UoxKm', 'cutting_verifier', 'Nadeeka Silva (Cutting Verifier)'),
  ('sewing@apparelflow.com', '$2b$10$pP0aLNRV.hUuO6AbMyGWqODgRUI6AZa9bGzTpFScZWuRkf58UoxKm', 'sewing_supervisor', 'Dinesh Fernando (Sewing Supervisor)')
ON CONFLICT (email) DO NOTHING;

-- 2. Recipe A: Casual Blouse (Code: REC-BL01)
INSERT INTO recipes (recipe_code, name, category, std_fabric_yards, wastage_cap)
VALUES ('REC-BL01', 'Casual Blouse', 'Blouse', 1.80, 5.00)
ON CONFLICT (recipe_code) DO NOTHING;

-- Components for Recipe A
INSERT INTO recipe_components (recipe_id, component_name, pieces_per_garment, image_url)
SELECT r.id, c.component_name, c.pieces_per_garment, c.image_url
FROM recipes r
CROSS JOIN (VALUES
  ('Front Body Panel', 1, '/components/front_body.png'),
  ('Back Body Panel', 1, '/components/back_body.png'),
  ('Sleeves (Left & Right)', 2, '/components/sleeves.png'),
  ('Collar & Stand', 1, '/components/collar.png'),
  ('Sleeve Cuffs', 2, '/components/cuffs.png')
) AS c(component_name, pieces_per_garment, image_url)
WHERE r.recipe_code = 'REC-BL01'
AND NOT EXISTS (
  SELECT 1 FROM recipe_components rc WHERE rc.recipe_id = r.id AND rc.component_name = c.component_name
);

-- 3. Recipe B: Crop Top (Code: REC-CT02)
INSERT INTO recipes (recipe_code, name, category, std_fabric_yards, wastage_cap)
VALUES ('REC-CT02', 'Crop Top', 'Crop Top', 1.10, 8.00)
ON CONFLICT (recipe_code) DO NOTHING;

-- Components for Recipe B
INSERT INTO recipe_components (recipe_id, component_name, pieces_per_garment, image_url)
SELECT r.id, c.component_name, c.pieces_per_garment, c.image_url
FROM recipes r
CROSS JOIN (VALUES
  ('Front Chest Panel', 1, '/components/front_chest.png'),
  ('Back Support Panel', 1, '/components/back_support.png'),
  ('Neck Binding Strip', 1, '/components/neck_binding.png'),
  ('Hem Elastic Casing', 1, '/components/elastic_casing.png'),
  ('Side Strap Accents', 2, '/components/side_straps.png')
) AS c(component_name, pieces_per_garment, image_url)
WHERE r.recipe_code = 'REC-CT02'
AND NOT EXISTS (
  SELECT 1 FROM recipe_components rc WHERE rc.recipe_id = r.id AND rc.component_name = c.component_name
);
