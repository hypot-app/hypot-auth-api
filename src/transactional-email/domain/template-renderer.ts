export interface RenderedEmail {
  subject: string;
  text: string;
}

/** Port: turns a template name and its variables into subject and body. */
export interface TemplateRenderer {
  /** `clientId` selects a per-app template override and falls back to the default set. */
  render(input: { template: string; clientId: string; variables: Record<string, string> }): Promise<RenderedEmail>;
}

export const TEMPLATE_RENDERER = Symbol('TemplateRenderer');
