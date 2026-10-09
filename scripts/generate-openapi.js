'use strict';
// Writes the OpenAPI 3.1 document to openapi.json. Run through `npm run openapi:generate`, which builds first.
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { buildOpenApiDocument } = require('../dist/openapi/openapi-document');
const { version } = require('../package.json');

const target = join(__dirname, '..', 'openapi.json');
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument({ version }), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
