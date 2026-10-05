import { ensureKeySetFile } from './signing-key-generator';

/**
 * Dev tooling: node dist/token-lifecycle/infrastructure/generate-signing-keys.js [path]
 * Creates an active + next RSA key set unless the file already exists. Production keys
 * come from the platform secret store, not from this script.
 */
const path = process.argv[2] ?? '.keys/signing-keys.json';
const outcome = ensureKeySetFile(path);
console.log(outcome === 'created' ? `Signing keys written to ${path}` : `Signing keys already exist at ${path}; left untouched`);
