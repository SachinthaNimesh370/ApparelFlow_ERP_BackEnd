import dotenv from 'dotenv';
dotenv.config();

import app from './app.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[ApparelFlow ERP] Backend server running on port ${PORT}`);
  console.log(`[ApparelFlow ERP] Environment: ${process.env.NODE_ENV || 'development'}`);
});
