// Runtime array of valid roles (exists in compiled JS)
export const VALID_ROLES = ['ADMIN', 'MENTOR_MANAGER', 'MENTOR', 'STUDENT', 'LETTER_WRITER', 'SETTER'] as const;

// Derive the type from the array so they stay in sync
export type UserRole = (typeof VALID_ROLES)[number];

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  avatar?: string;
  createdAt: string;
  weeklyLeadGoal?: number;
  monthlyLeadGoal?: number;
}

export interface Invitation {
  id: string;
  email: string;
  role: UserRole;
  invitedBy: string;
  invitedByName: string;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
}

export interface SignInRequest {
  email: string;
  password: string;
}

export interface ResetPasswordRequest {
  email: string;
}

export interface PostBacOrMasters {
  enabled: boolean;
  institution: string;
  strengthScore: number;
  degreeType: string;
  year: string;
}

export interface StudentProfile {
  id: string;
  mentor_id?: string | null;
  readiness: 'GREEN' | 'YELLOW' | 'RED';
  last_meeting_date?: string | null;
  next_meeting_date?: string | null;
  last_contact_date?: string | null;
  missing_docs_count: number;
  open_action_items_count: number;
  progress: number;
  zip_code?: string | null;
  strength_score: number;
  gpa?: number | null;
  avg_response_time: number;
  dat_score?: number | null;
  dat_aa?: number | null;
  dat_ts?: number | null;
  is_reapplicant: boolean;
  application_cycle?: string | null;
  status: 'Preparing' | 'Applying' | 'Interviewing';
  state?: string | null;
  country?: string | null;
  ethnicity?: string | null;
  gender?: string | null;
  age?: number | null;
  dat_verified: boolean;
  gpa_verified?: boolean;
  undergrad_institution?: string | null;
  undergrad_degree?: string | null;
  undergrad_grad_year?: string | null;
  post_bac?: PostBacOrMasters | null;
  masters?: PostBacOrMasters | null;
  lor_required: number;
  lor_external_service: boolean;
  timezone?: string | null;
  last_profile_reminder_at?: string | null;
  school_categories?: Array<{ id: string; name: string; color: string; icon: string }> | null;
  created_at: string;
  updated_at: string;
}
  id: string;
  avg_response_time: string;
  avg_response_time_value: number;
  compliance_score: number;
  default_availability: string[];
  phone?: string | null;
  school?: string | null;
  graduation_year?: string | null;
  notes?: string | null;
  manager_score: number;
  created_at: string;
  updated_at: string;
}

export interface StudentAssignment {
  id: string;
  student_id: string;
  mentor_id?: string | null;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TRANSFERRED';
  assigned_at: string;
  accepted_at?: string | null;
  transferred_at?: string | null;
  available_times: string[];
  welcome_message?: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  name?: string | null;
  participant_ids: string[];
  is_group: boolean;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  text: string;
  is_read: boolean;
  read_by: string[];
  created_at: string;
}

export type MeetingAudience =
  | 'ADMIN_DIRECT'
  | 'STUDENT'
  | 'MENTORS'
  | 'STAFF'
  | 'GLOBAL';

export interface Meeting {
  id: string;
  student_id?: string | null;
  mentor_id: string;
  title: string;
  date: string;
  timezone: string;
  duration: number;
  summary?: string | null;
  notes?: string | null;
  mentor_notes?: string | null;
  type: 'STUDENT_MEETING' | 'MANAGER_MEETING' | 'GENERAL';
  audience?: MeetingAudience | null;
  link?: string | null;
  completed: boolean;
  attendees: string[];
  created_at: string;
  updated_at: string;
}

export interface ActionItem {
  id: string;
  student_id: string;
  meeting_id?: string | null;
  task: string;
  due_date: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'PENDING' | 'COMPLETED' | 'OVERDUE';
  description?: string | null;
  category?: string | null;
  resource_id?: string | null;
  resource_link?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  type: 'MEETING' | 'TASK_DUE' | 'MANAGER_MEETING';
  mentorId?: string;
  studentId?: string;
  status?: string;
}

export interface StaffTask {
  id: string;
  assigned_to: string;
  assigned_by: string;
  task: string;
  description?: string | null;
  due_date: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'PENDING' | 'COMPLETED' | 'OVERDUE';
  related_doc_id?: string | null;
  student_id?: string | null;
  created_at: string;
  updated_at: string;
}

export type DocumentType = 'Transcript' | 'Resume' | 'Letter of Recommendation' | 'Post-Bac Transcript' | 'DAT Report' | 'Essay' | 'Other';

export interface StudentDocument {
  id: string;
  student_id: string;
  title: string;
  type: DocumentType;
  url: string;
  status: 'Pending Review' | 'Reviewed' | 'Needs Revision';
  comment?: string | null;
  private_note?: string | null;
  uploaded_at: string;
  updated_at: string;
}

export type ExperienceCategory = 'Volunteering' | 'Research' | 'Shadowing' | 'Dental Experience' | 'Employment' | 'Academic';

export interface Experience {
  id: string;
  student_id: string;
  category: ExperienceCategory;
  title: string;
  organization: string;
  supervisor_name?: string | null;
  supervisor_contact?: string | null;
  description?: string | null;
  start_date: string;
  end_date?: string | null;
  is_ongoing: boolean;
  dentist_type?: 'General' | 'Specialty' | null;
  created_at: string;
  updated_at: string;
  sessions?: ExperienceSession[];
}

export interface ExperienceSession {
  id: string;
  experience_id: string;
  date: string;
  duration: number; // hours
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface School {
  id: string;
  name: string;
  location: string;
  strength_score_avg: number;
  dat_avg: number;
  avg_gpa: number;
  acceptance_rate?: number | null;
  is_acceptance_rate?: number | null;
  oos_acceptance_rate?: number | null;
  cc_credits: boolean;
  tuition?: string | null;
  notes?: string | null;
  in_state_enrollment?: number | null;
  out_of_state_enrollment?: number | null;
  male_enrollment?: number | null;
  female_enrollment?: number | null;
  ethnicity?: Record<string, number> | null;
  min_dat_5th?: number | null;
  min_cgpa_5th?: number | null;
  created_at: string;
  updated_at: string;
}

export interface StudentSchool {
  id: string;
  student_id: string;
  school_id: string;
  category: 'Reach' | 'Target' | 'Safety';
  status: 'Interested' | 'Applying' | 'Applied' | 'Interviewed' | 'Accepted' | 'Waitlisted' | 'Rejected';
  applied_date?: string | null;
  interview_date?: string | null;
  decision_date?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  school?: School;
}

export type ApplicationStatus = 'Interested' | 'Applying' | 'Applied' | 'Interviewed' | 'Accepted' | 'Waitlisted' | 'Rejected';

export interface Application {
  id: string;
  student_id: string;
  school_id: string;
  status: ApplicationStatus;
  applied_date?: string | null;
  interview_date?: string | null;
  decision_date?: string | null;
  created_at: string;
  updated_at: string;
  school?: School;
}

export interface SurveyQuestion {
  id: string;
  type: 'TEXT' | 'MULTIPLE_CHOICE' | 'RATING';
  questionText: string;
  options?: string[];
  required: boolean;
}

export interface Survey {
  id: string;
  title: string;
  description?: string | null;
  questions: SurveyQuestion[];
  target_role: 'STUDENT' | 'MENTOR' | 'BOTH';
  is_active: boolean;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SurveyResponse {
  id: string;
  survey_id: string;
  user_id: string;
  answers: Array<{ questionId: string; answerText: string }>;
  submitted_at: string;
}

export interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  benchmark_type: 'PROGRESS' | 'STRENGTH_SCORE' | 'DAT' | 'TASKS_COMPLETED' | 'MEETINGS_ATTENDED';
  benchmark_value: number;
  created_at: string;
  updated_at: string;
}

export interface StudentBadge {
  id: string;
  student_id: string;
  badge_id: string;
  earned_at: string;
  badge?: Badge;
}

export interface WorkflowStep {
  id: string;
  type: 'SEND_MESSAGE';
  delayHours: number;
  messageTemplate: string;
  isFollowUp?: boolean;
  followUpAfterHours?: number;
}

export interface Workflow {
  id: string;
  name: string;
  trigger: 'FIRST_ACCEPTANCE' | 'APPLICATION_SUBMITTED' | 'INTERVIEW_RECEIVED';
  steps: WorkflowStep[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PendingWorkflowAction {
  id: string;
  workflow_id: string;
  step_id: string;
  student_id: string;
  trigger_data: any;
  scheduled_for: string;
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED';
  created_at: string;
  updated_at: string;
  workflow?: Workflow;
}

export interface PopupAdvertisement {
  id: string;
  title: string;
  message: string;
  image_url?: string | null;
  cta_text?: string | null;
  cta_url?: string | null;
  background_color?: string | null;
  text_color?: string | null;
  target_role: 'STUDENT' | 'MENTOR' | 'ADMIN' | 'MENTOR_MANAGER' | 'BOTH';
  start_date: string;
  end_date: string;
  is_active: boolean;
  created_by: string;
  dismissed_by: string[];
  created_at: string;
  updated_at: string;
}

export interface KPIAssessment {
  academics: 'Strong' | 'Moderate' | 'Developing' | 'Weak';
  experienceDepth: 'Strong' | 'Moderate' | 'Developing' | 'Weak';
  leadership: 'Strong' | 'Moderate' | 'Developing' | 'Weak';
  shadowing: 'Strong' | 'Moderate' | 'Developing' | 'Weak';
}

export interface RoadmapPhases {
  phase1: string[];
  phase2: string[];
  phase3: string[];
  phase4: string[];
}

export interface RiskFactor {
  factor: string;
  severity: 'High' | 'Medium' | 'Low';
  description: string;
  mitigation: string;
}

export interface LeverageAction {
  title: string;
  description: string;
  impact: 'High' | 'Moderate' | 'Lower';
}

export interface OptimizationPlan {
  id: string;
  student_id: string;
  snapshot: string;
  overall_score: number;
  improvement_leverage_score: number;
  kpis: KPIAssessment;
  roadmap: RoadmapPhases;
  risk_factors: RiskFactor[];
  leverage_actions: LeverageAction[];
  strengths: string[];
  gaps: string[];
  created_at: string;
  updated_at: string;
}

export interface AdminSettings {
  id: number;
  platform_name: string;
  support_email: string;
  maintenance_mode: boolean;
  auto_reply_enabled: boolean;
  auto_reply_message?: string | null;
  auto_reply_inactivity_minutes?: number;
  auto_reply_rate_limit_minutes?: number;
  welcome_template_student?: string | null;
  welcome_template_mentor?: string | null;
  accepted_message?: string | null;
  interview_message?: string | null;
  waitlist_message?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchCase {
  id: string;
  student_name_anonymized: string;
  gpa: number;
  dat_aa: number;
  dat_ts: number;
  major?: string | null;
  undergrad_institution?: string | null;
  shadowing_hours: number;
  volunteering_hours: number;
  research_hours: number;
  accepted_schools: string[];
  rejected_schools: string[];
  matriculated_school?: string | null;
  cycle: string;
  special_circumstances?: string | null;
  created_at: string;
  updated_at: string;
}















