import express from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// GET /api/recipes
router.get('/', authenticate, async (req, res) => {
  try {
    const { rows: recipes } = await pool.query(
      'SELECT id, recipe_code, name, category, std_fabric_yards, wastage_cap FROM recipes ORDER BY id ASC'
    );

    const { rows: components } = await pool.query(
      'SELECT id, recipe_id, component_name, pieces_per_garment, image_url FROM recipe_components ORDER BY id ASC'
    );

    const recipesWithComponents = recipes.map((recipe) => ({
      ...recipe,
      std_fabric_yards: parseFloat(recipe.std_fabric_yards),
      wastage_cap: parseFloat(recipe.wastage_cap),
      components: components
        .filter((c) => c.recipe_id === recipe.id)
        .map((c) => ({
          ...c,
          pieces_per_garment: parseInt(c.pieces_per_garment, 10)
        }))
    }));

    res.json(recipesWithComponents);
  } catch (err) {
    console.error('Fetch recipes error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/recipes/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows: recipes } = await pool.query(
      'SELECT id, recipe_code, name, category, std_fabric_yards, wastage_cap FROM recipes WHERE id = $1',
      [req.params.id]
    );

    if (recipes.length === 0) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    const recipe = recipes[0];
    const { rows: components } = await pool.query(
      'SELECT id, recipe_id, component_name, pieces_per_garment, image_url FROM recipe_components WHERE recipe_id = $1 ORDER BY id ASC',
      [recipe.id]
    );

    res.json({
      ...recipe,
      std_fabric_yards: parseFloat(recipe.std_fabric_yards),
      wastage_cap: parseFloat(recipe.wastage_cap),
      components: components.map((c) => ({
        ...c,
        pieces_per_garment: parseInt(c.pieces_per_garment, 10)
      }))
    });
  } catch (err) {
    console.error('Fetch recipe error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
