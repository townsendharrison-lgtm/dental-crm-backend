import 'dotenv/config'; // Must be first — loads .env before any other module reads process.env
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authRouter } from './routes/auth.js';
import { userRouter } from './routes/users.js';
import { adminRouter } from './routes/admin.js';
import { publicRouter } from './routes/public.js';
import { notificationRouter } from './routes/notifications.js';
import { leadsRouter } from './routes/leads.js';
import { lorRouter } from './routes/lor.js';
import { dentistsRouter } from './routes/dentists.js';
import { errorHandler } from './middleware/errorHandler.js';
import { startReminderCron } from './services/lorReminderCron.js';

const app = express();
const PORT = process.env.PORT || 5001;

// Rate limiting for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'http://localhost:3000',
      'https://dental-school-guide-crm.vercel.app',
    ];
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all origins in development; tighten in production if needed
    }
  },
  credentials: true
}));
app.use(express.json());

// Routes
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/users', userRouter);
app.use('/api/admin', adminRouter);
app.use('/api/public', publicRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/lor', lorRouter);
app.use('/api/dentists', dentistsRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
  // Start automated LOR reminder cron
  startReminderCron();
});
