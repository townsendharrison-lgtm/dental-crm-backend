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
import { shadowReportsRouter } from './routes/shadowReports.js';
import { studentsRouter } from './routes/students.js';
import { mentorsRouter } from './routes/mentors.js';
import { messagesRouter } from './routes/messages.js';
import { meetingsRouter } from './routes/meetings.js';
import { actionItemsRouter } from './routes/actionItems.js';
import { staffTasksRouter } from './routes/staffTasks.js';
import { documentsRouter } from './routes/documents.js';
import { experiencesRouter } from './routes/experiences.js';
import { schoolsRouter } from './routes/schools.js';
import { studentSchoolsRouter } from './routes/studentSchools.js';
import { applicationsRouter } from './routes/applications.js';
import { surveysRouter } from './routes/surveys.js';
import { badgesRouter } from './routes/badges.js';
import { workflowsRouter } from './routes/workflows.js';
import { popupsRouter } from './routes/popups.js';
import { resourcesRouter } from './routes/resources.js';
import { optimizationPlansRouter } from './routes/optimizationPlans.js';
import { adminSettingsRouter } from './routes/adminSettings.js';
import { researchCasesRouter } from './routes/researchCases.js';
import { errorHandler } from './middleware/errorHandler.js';
import { startReminderCron } from './services/lorReminderCron.js';
import { startWorkflowCron } from './services/workflowCron.js';
import { supabaseAdmin } from './config/supabase.js';

const app = express();
app.set('trust proxy', 1);
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

// Maintenance Mode Guard Middleware
app.use(async (req, res, next) => {
  // Allow safe reading requests, public routes, auth routes, and health checks
  if (
    req.method === 'GET' ||
    req.path.startsWith('/api/auth') ||
    req.path.startsWith('/api/public') ||
    req.path === '/health'
  ) {
    return next();
  }

  try {
    const { data: config } = await supabaseAdmin
      .from('admin_settings')
      .select('maintenance_mode')
      .eq('id', 1)
      .maybeSingle();

    if (config?.maintenance_mode) {
      // Decode user role from token manually to verify if Admin
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const { data: { user } } = await supabaseAdmin.auth.getUser(token);
        const role = user?.user_metadata?.role || 'STUDENT';
        if (role === 'ADMIN') {
          return next(); // Admins bypass maintenance mode
        }
      }
      return res.status(503).json({
        error: 'The platform is currently undergoing scheduled maintenance. Write operations are temporarily disabled.'
      });
    }
  } catch (err) {
    console.error('Maintenance mode verification error:', err);
  }
  next();
});

// Routes
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/users', userRouter);
app.use('/api/admin', adminRouter);
app.use('/api/public', publicRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/lor', lorRouter);
app.use('/api/dentists', dentistsRouter);
app.use('/api/shadow-reports', shadowReportsRouter);
app.use('/api/students', studentsRouter);
app.use('/api/mentors', mentorsRouter);
app.use('/api/conversations', messagesRouter);
app.use('/api/meetings', meetingsRouter);
app.use('/api/action-items', actionItemsRouter);
app.use('/api/staff-tasks', staffTasksRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/experiences', experiencesRouter);
app.use('/api/schools', schoolsRouter);
app.use('/api/student-schools', studentSchoolsRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/surveys', surveysRouter);
app.use('/api/badges', badgesRouter);
app.use('/api/workflows', workflowsRouter);
app.use('/api/popups', popupsRouter);
app.use('/api/resources', resourcesRouter);
app.use('/api/optimization-plans', optimizationPlansRouter);
app.use('/api/admin-settings', adminSettingsRouter);
app.use('/api/research-cases', researchCasesRouter);

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
  // Start workflow queue processor
  startWorkflowCron();
});
