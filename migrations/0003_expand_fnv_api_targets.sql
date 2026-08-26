-- The original fnv fixture described four proved methods in prose, but only
-- attached the functional-correctness result to FnvHasher::write. Preserve
-- the write result and add one precise result for each other proved method so
-- the API index is derived from structured SARIF rather than natural language.
UPDATE sarif_runs
SET run_json = json_set(
  json_insert(
    run_json,
    '$.results[#]', json_object(
      'ruleId', 'fnv.functional-correctness',
      'kind', 'pass',
      'level', 'note',
      'message', json_object(
        'text', 'PASS: FnvHasher::default returns a hasher whose abstract state is the FNV-1a 64-bit offset basis 0xcbf29ce484222325.'
      ),
      'properties', json_object(
        'verification_status', 'proved',
        'not_a_vulnerability', json('true')
      ),
      'locations', json_array(json_object(
        'logicalLocations', json_array(json_object(
          'fullyQualifiedName', 'fnv::FnvHasher::default',
          'kind', 'function'
        )),
        'physicalLocation', json_object(
          'artifactLocation', json_object('uri', 'lib.rs'),
          'region', json_object('startLine', 164, 'endLine', 168)
        )
      ))
    ),
    '$.results[#]', json_object(
      'ruleId', 'fnv.functional-correctness',
      'kind', 'pass',
      'level', 'note',
      'message', json_object(
        'text', 'PASS: FnvHasher::with_key(key) returns a hasher whose abstract state is exactly key.'
      ),
      'properties', json_object(
        'verification_status', 'proved',
        'not_a_vulnerability', json('true')
      ),
      'locations', json_array(json_object(
        'logicalLocations', json_array(json_object(
          'fullyQualifiedName', 'fnv::FnvHasher::with_key',
          'kind', 'function'
        )),
        'physicalLocation', json_object(
          'artifactLocation', json_object('uri', 'lib.rs'),
          'region', json_object('startLine', 174, 'endLine', 178)
        )
      ))
    ),
    '$.results[#]', json_object(
      'ruleId', 'fnv.functional-correctness',
      'kind', 'pass',
      'level', 'note',
      'message', json_object(
        'text', 'PASS: Hasher::finish returns the FnvHasher current abstract 64-bit state without changing it.'
      ),
      'properties', json_object(
        'verification_status', 'proved',
        'not_a_vulnerability', json('true')
      ),
      'locations', json_array(json_object(
        'logicalLocations', json_array(json_object(
          'fullyQualifiedName', 'fnv::FnvHasher::finish',
          'kind', 'function'
        )),
        'physicalLocation', json_object(
          'artifactLocation', json_object('uri', 'lib.rs'),
          'region', json_object('startLine', 182, 'endLine', 185)
        )
      ))
    )
  ),
  '$.results[0].message.text',
  'PASS: FnvHasher::write updates the old abstract state to the recursive FNV-1a fold of every input byte for arbitrary input slices and initial 64-bit states.'
)
WHERE publication_id = '01M0Y9XDRX507PG4H5YPP9BAP2'
  AND json_extract(run_json, '$.results[0].locations[0].logicalLocations[0].fullyQualifiedName') = 'fnv::FnvHasher::write'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(json_extract(run_json, '$.results')) AS result
    WHERE json_extract(result.value, '$.locations[0].logicalLocations[0].fullyQualifiedName') = 'fnv::FnvHasher::default'
  );
