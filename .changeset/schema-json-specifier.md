---
'@hudhudjs/core': patch
'@hudhudjs/claude-code': patch
'hudhudjs': patch
---

The schemas now import by their file names, as documented (pre-release review R5-6): `@hudhudjs/core/schemas/events.schema.json` and `@hudhudjs/claude-code/schemas/options.schema.json` resolve to those files. Before, the `exports` map added `.json` to every specifier, so the `.json` form looked for `events.schema.json.json` and failed with `ERR_MODULE_NOT_FOUND`. The form without `.json` still works. Import a schema with the attribute `{ type: 'json' }`.
