-- Database Migration: Add Pinned and Deleted Status tracking for Users on Conversations
-- Targets: public.conversations

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS pinned_by UUID[] NOT NULL DEFAULT '{}'::UUID[];
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS deleted_by UUID[] NOT NULL DEFAULT '{}'::UUID[];
