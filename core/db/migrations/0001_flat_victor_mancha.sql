DROP INDEX "approvals_version_member_uq";--> statement-breakpoint
CREATE INDEX "approvals_version_member_idx" ON "approvals" USING btree ("version_id","member_id");