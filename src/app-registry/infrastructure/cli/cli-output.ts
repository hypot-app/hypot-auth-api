/** Port for what the operator CLI prints, so tests can capture it. */
export interface CliOutput {
  out(line: string): void;
  error(line: string): void;
}

export const CLI_OUTPUT = Symbol('CliOutput');

export const processCliOutput: CliOutput = {
  out: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
};
