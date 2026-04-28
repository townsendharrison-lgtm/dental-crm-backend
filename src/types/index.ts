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
