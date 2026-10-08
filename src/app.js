import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth.js';
import recipesRoutes from './routes/recipes.js';
import ordersRoutes from './routes/orders.js';
import sewingRoutes from './routes/sewing.js';

const app = express();

// Security and middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check endpoint
const handleHealth = (req, res) => {
  res.json({
    status: 'ok',
    system: 'ApparelFlow ERP Execution System',
    timestamp: new Date().toISOString()
  });
};
app.get('/health', handleHealth);
app.get('/api/health', handleHealth);

// API Routes mounted under both /api and root to handle direct and nginx-proxied requests seamlessly
app.use('/api/auth', authRoutes);
app.use('/auth', authRoutes);

app.use('/api/recipes', recipesRoutes);
app.use('/recipes', recipesRoutes);

app.use('/api/orders', ordersRoutes);
app.use('/orders', ordersRoutes);

app.use('/api/sewing', sewingRoutes);
app.use('/sewing', sewingRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Centralized error handling
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
