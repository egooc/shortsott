# Schema Probe Archive

These files were created during Phase C-8 to isolate Vertex `responseSchema` subset behavior.

- `gemini_response_schema_minimal.json`: L1 minimal type/properties probe.
- `gemini_response_schema_L2_add_required.json`: L2 added required fields.
- `gemini_response_schema_L4_add_minmax.json`: L4 added minItems/maxItems; the probe returned 429, so support remains inconclusive.
- `gemini_response_schema_L5_add_full.json`: L5 full schema snapshot that matched the pre-C9 active schema; run_005 returned 400 with the full schema.
- `gemini_response_schema_L3_production.json`: L3 production snapshot aligned for baseline re-activation (same shape as `gemini_response_schema.json.bak.20260710_c9_pre_L3`).

Active schema lives at `../gemini_response_schema.json` and is a production L3 baseline: required + enum, without minItems/maxItems/propertyOrdering.
