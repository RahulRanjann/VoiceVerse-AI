-- Supabase Auth becomes the browser identity issuer while VoiceVerse retains
-- internal users, organizations, memberships, and authorization policy.
ALTER TYPE "identity_provider" ADD VALUE IF NOT EXISTS 'supabase';
