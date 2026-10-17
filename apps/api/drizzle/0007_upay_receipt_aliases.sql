CREATE TABLE "upay_submission_aliases" (
  "kind" text NOT NULL,
  "alias" text NOT NULL,
  "reference" text NOT NULL REFERENCES "upay_submissions"("reference"),
  CONSTRAINT "upay_submission_aliases_kind_alias_pk" PRIMARY KEY("kind", "alias")
);
