-- Historical records keep their original prose and do not acquire an inferred safety classification.
ALTER TABLE verification_records ADD COLUMN api_safety TEXT NOT NULL DEFAULT 'unknown' CHECK(api_safety IN ('safe','unsafe','unknown'));
ALTER TABLE verification_records ADD COLUMN contract_language TEXT NOT NULL DEFAULT 'legacy' CHECK(contract_language IN ('rust','kani','verus','creusot','legacy'));
