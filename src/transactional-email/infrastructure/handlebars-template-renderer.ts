import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Handlebars from 'handlebars';
import { isEmailTemplate } from '../domain/email-template';
import type { RenderedEmail, TemplateRenderer } from '../domain/template-renderer';

const DEFAULT_SET = 'default';

/** A client_id names a directory, so only plain names are accepted (no separators, no dots). */
const SAFE_SET_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A subject is one header line: line breaks from a variable must not start a new header. */
const LINE_BREAKS = /[\r\n]+/g;

/**
 * Renders emails from Handlebars files laid out as
 * `<root>/<set>/<template>.{subject,text}.hbs`, where `<set>` is `default` or a
 * client_id. Each part falls back from the app's override to the default set.
 *
 * Subject and text are plain text, so they are not HTML-escaped (a `&` stays a `&`).
 * Templates run on an isolated Handlebars instance with no custom helpers and strict
 * mode: an undefined variable fails the render instead of printing nothing, and object
 * internals such as `constructor` are not reachable.
 */
export class HandlebarsTemplateRenderer implements TemplateRenderer {
  private readonly handlebars = Handlebars.create();

  constructor(private readonly root: string) {}

  async render(input: {
    template: string;
    clientId: string;
    variables: Record<string, string>;
  }): Promise<RenderedEmail> {
    if (!isEmailTemplate(input.template)) throw new Error('unknown template');
    const sets = SAFE_SET_NAME.test(input.clientId) ? [input.clientId, DEFAULT_SET] : [DEFAULT_SET];

    const subject = await this.required(sets, input.template, 'subject');
    const text = await this.required(sets, input.template, 'text');

    return {
      subject: this.fill(subject, input.variables).replace(LINE_BREAKS, ' '),
      text: this.fill(text, input.variables),
    };
  }

  /** The first existing file among the sets. Both parts must exist in at least the default set. */
  private async required(sets: string[], template: string, kind: 'subject' | 'text'): Promise<string> {
    for (const set of sets) {
      const source = await readIfExists(join(this.root, set, `${template}.${kind}.hbs`));
      if (source !== null) return source;
    }
    throw new Error(`template file not found: ${template}.${kind}.hbs`);
  }

  /** noEscape: subject and text are plain text. */
  private fill(source: string, variables: Record<string, string>): string {
    return this.handlebars.compile(source, { noEscape: true, strict: true })(variables);
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
