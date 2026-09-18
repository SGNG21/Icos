-- Add created_at column to audit_entries table
ALTER TABLE "audit_entries" ADD COLUMN "created_at" timestamp with time zone NOT NULL DEFAULT now();
