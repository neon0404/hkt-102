CREATE TABLE "link_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"visitor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"publication_id" uuid,
	"code" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_links_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "post_versions" ADD COLUMN "video" jsonb;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "views" integer;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "reactions" integer;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "stats_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "link_clicks" ADD CONSTRAINT "link_clicks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_clicks" ADD CONSTRAINT "link_clicks_link_id_tracked_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."tracked_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "link_clicks_link_visitor_uq" ON "link_clicks" USING btree ("link_id","visitor");--> statement-breakpoint
CREATE INDEX "tracked_links_post_idx" ON "tracked_links" USING btree ("post_id");