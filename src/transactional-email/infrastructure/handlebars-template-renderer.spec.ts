import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandlebarsTemplateRenderer } from './handlebars-template-renderer';

const CLIENT = 'app_0123456789abcdef0123456789abcdef';
const OTHER_CLIENT = 'app_fedcba9876543210fedcba9876543210';

describe('HandlebarsTemplateRenderer', () => {
  let root: string;
  let renderer: HandlebarsTemplateRenderer;

  const put = async (set: string, file: string, content: string) => {
    await mkdir(join(root, set), { recursive: true });
    await writeFile(join(root, set, file), content);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hypot-templates-'));
    renderer = new HandlebarsTemplateRenderer(root);
    await put('default', 'welcome.subject.hbs', 'Welcome to {{appName}}');
    await put('default', 'welcome.text.hbs', 'Hello from {{appName}}.');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const render = (overrides: Partial<Parameters<HandlebarsTemplateRenderer['render']>[0]> = {}) =>
    renderer.render({ template: 'welcome', clientId: CLIENT, variables: { appName: 'Shop' }, ...overrides });

  describe('template selection', () => {
    it('uses the default set when the app has no override', async () => {
      expect(await render()).toEqual({ subject: 'Welcome to Shop', text: 'Hello from Shop.' });
    });

    it('uses the per-client override for the matching client_id only', async () => {
      await put(CLIENT, 'welcome.subject.hbs', 'Hi from the {{appName}} team');
      await put(CLIENT, 'welcome.text.hbs', 'Custom body');

      expect(await render({ clientId: CLIENT })).toEqual({ subject: 'Hi from the Shop team', text: 'Custom body' });
      expect(await render({ clientId: OTHER_CLIENT })).toEqual({ subject: 'Welcome to Shop', text: 'Hello from Shop.' });
    });

    it('falls back to the default for a template the override does not define', async () => {
      await put(CLIENT, 'confirmation.subject.hbs', 'Custom confirm');
      await put(CLIENT, 'confirmation.text.hbs', 'Custom confirm body');

      expect((await render({ clientId: CLIENT })).subject).toBe('Welcome to Shop');
    });

    it('ignores a client_id that is not a plain directory name, so it cannot reach other paths', async () => {
      await mkdir(join(root, '..', 'escape'), { recursive: true });
      await writeFile(join(root, '..', 'escape', 'welcome.subject.hbs'), 'ESCAPED');
      await writeFile(join(root, '..', 'escape', 'welcome.text.hbs'), 'ESCAPED');
      try {
        for (const clientId of ['../escape', '..', 'a/b', 'a\\b', '']) {
          expect(await render({ clientId })).toEqual({ subject: 'Welcome to Shop', text: 'Hello from Shop.' });
        }
      } finally {
        await rm(join(root, '..', 'escape'), { recursive: true, force: true });
      }
    });

    it('rejects a template name that is not a known auth email', async () => {
      await expect(render({ template: '../default/welcome' })).rejects.toThrow('unknown template');
      await expect(render({ template: 'newsletter' })).rejects.toThrow('unknown template');
    });

    it('fails when the default set lacks the template', async () => {
      await expect(render({ template: 'confirmation' })).rejects.toThrow(/confirmation\.subject\.hbs/);
    });
  });

  describe('escaping', () => {
    it('escapes variables in the html part', async () => {
      await put('default', 'welcome.html.hbs', '<p>Welcome to {{appName}}</p>');

      const rendered = await render({ variables: { appName: '<script>alert(1)</script>' } });

      expect(rendered.html).toBe('<p>Welcome to &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    });

    it('leaves html undefined when there is no html template', async () => {
      expect((await render()).html).toBeUndefined();
    });

    it('keeps plain text readable: no html entities in subject or text', async () => {
      const rendered = await render({ variables: { appName: `Tom & Jerry's` } });
      expect(rendered).toEqual({ subject: `Welcome to Tom & Jerry's`, text: `Hello from Tom & Jerry's.` });
    });

    it('collapses line breaks in the subject so a variable cannot inject headers', async () => {
      const rendered = await render({ variables: { appName: 'Shop\r\nBcc: evil@example.com' } });
      expect(rendered.subject).toBe('Welcome to Shop Bcc: evil@example.com');
    });
  });

  describe('safety', () => {
    it('fails on a variable the template uses but was not given', async () => {
      await expect(render({ variables: {} })).rejects.toThrow(/"appName" not defined/);
    });

    it('does not expose object internals to a template', async () => {
      await put(CLIENT, 'welcome.subject.hbs', '{{constructor.name}}');
      await put(CLIENT, 'welcome.text.hbs', 'x');

      await expect(render({ clientId: CLIENT })).rejects.toThrow(/"name" not defined in undefined/);
    });
  });
});
