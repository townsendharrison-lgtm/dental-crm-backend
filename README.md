# Dental CRM Backend

Node.js backend with Supabase authentication for the Dental CRM application.

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Supabase

1. Create a Supabase project at https://supabase.com
2. Go to Project Settings > API to get your credentials
3. Copy the `.env.example` file to `.env`:
```bash
cp .env.example .env
```
4. Fill in your Supabase credentials in `.env`:
```
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
PORT=5001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

### 3. Set Up Database Schema

1. Go to your Supabase project's SQL Editor
2. Open the `supabase-schema.sql` file
3. Run the SQL script to create the necessary tables and policies

### 4. Create Initial Admin User

You'll need to create the first admin user manually through the Supabase dashboard:
1. Go to Authentication > Users in Supabase
2. Click "Add user" and create an admin account
3. Go to Table Editor > users table
4. Update the user's role to 'ADMIN'

## API Endpoints

### Authentication (`/api/auth`)

- `POST /api/auth/signup` - Sign up with invitation token
- `POST /api/auth/signin` - Sign in
- `POST /api/auth/signout` - Sign out
- `POST /api/auth/reset-password` - Request password reset
- `POST /api/auth/update-password` - Update password (after reset)
- `GET /api/auth/me` - Get current user

### Users (`/api/users`)

- `GET /api/users/profile` - Get user profile (authenticated)
- `PUT /api/users/profile` - Update user profile (authenticated)
- `GET /api/users/role/:role` - Get users by role (admin/mentor manager only)

### Admin (`/api/admin`)

- `POST /api/admin/invite` - Create user invitation (admin only)
- `GET /api/admin/invitations` - Get all invitations (admin only)
- `DELETE /api/admin/invitations/:id` - Delete invitation (admin only)
- `GET /api/admin/users` - Get all users (admin only)
- `PUT /api/admin/users/:id/role` - Update user role (admin only)
- `DELETE /api/admin/users/:id` - Delete user (admin only)

### Public (`/api/public`)

- `POST /api/public/letter-upload` - Upload letter (no auth required)
- `GET /api/public/letter/:id` - Get letter by ID (no auth required)

## Running the Server

Development mode:
```bash
npm run dev
```

Production mode:
```bash
npm run build
npm start
```

The server will run on port 5001 by default.

## User Roles

- **ADMIN** - Full access, can invite users and manage roles
- **MENTOR_MANAGER** - Can manage mentors and view certain data
- **MENTOR** - Can manage assigned students
- **STUDENT** - Can view and update own profile
- **SETTER** - Can manage lead generation
- **LETTER_WRITER** - Public access for letter uploads only

## Authentication Flow

1. Admin creates an invitation with a specific role
2. Invitation link is sent to the user's email
3. User clicks link and signs up with the invitation token
4. User's role is set based on the invitation
5. User can sign in and access their role-specific dashboard

## Security Notes

- All endpoints except `/api/public` require authentication
- Admin endpoints require ADMIN role
- Service role key is used for admin operations (bypasses RLS)
- Invitation tokens expire after 7 days
- Users cannot self-register - invitation only
