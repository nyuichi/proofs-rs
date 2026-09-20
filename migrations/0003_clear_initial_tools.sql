-- Remove only unused mock catalogue entries; preserve references in claim history.
DELETE FROM tool_versions
WHERE id IN (
  'kani-0.68.0',
  'kani-0.67.0',
  'miri-nightly-2026-09-16',
  'miri-nightly-2026-09-15',
  'verus-0.2026.09.13.671956e',
  'verus-0.2026.09.06.8dea4a2',
  'creusot-0.13.0',
  'creusot-0.12.0',
  'lean-4.22.0',
  'lean-4.21.0'
) AND NOT EXISTS (SELECT 1 FROM claim_revisions WHERE tool_version_id = tool_versions.id);

DELETE FROM tools
WHERE id IN ('kani', 'miri', 'verus', 'creusot', 'lean')
AND NOT EXISTS (SELECT 1 FROM tool_versions WHERE tool_id = tools.id);
