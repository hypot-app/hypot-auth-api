// tsc only emits .ts files. Email templates are .hbs files read at runtime, so
// they are copied next to the compiled code (dist/transactional-email/templates).
const { cpSync } = require('node:fs');

cpSync('src/transactional-email/templates', 'dist/transactional-email/templates', { recursive: true });
