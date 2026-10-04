import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const SMTP_PORT = 1025;
const HTTP_PORT = 8025;

export interface MailpitMessage {
  from: { name: string; address: string };
  to: { name: string; address: string }[];
  subject: string;
  text: string;
  html: string;
}

export interface TestMailpit {
  /** Where an SMTP client under test connects. */
  smtp: { host: string; port: number };
  /** Every message Mailpit received, oldest first, with bodies. */
  messages(): Promise<MailpitMessage[]>;
  clear(): Promise<void>;
  teardown(): Promise<void>;
}

interface MailpitListResponse {
  messages: { ID: string }[];
}

interface MailpitMessageResponse {
  From: { Name: string; Address: string };
  To: { Name: string; Address: string }[];
  Subject: string;
  Text: string;
  HTML: string;
}

/**
 * Starts a throwaway Mailpit container (ADR 25). It accepts any SMTP login, over
 * plain connections too, so auth wiring can be exercised. Requires a running Docker daemon.
 */
export async function startMailpit(): Promise<TestMailpit> {
  const container: StartedTestContainer = await new GenericContainer('axllent/mailpit:v1.31.3')
    .withExposedPorts(SMTP_PORT, HTTP_PORT)
    .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: '1', MP_SMTP_AUTH_ALLOW_INSECURE: '1' })
    .withWaitStrategy(Wait.forHttp('/livez', HTTP_PORT))
    .start();
  const api = `http://${container.getHost()}:${container.getMappedPort(HTTP_PORT)}/api/v1`;

  const getJson = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${api}${path}`);
    if (!response.ok) throw new Error(`Mailpit ${path} answered ${response.status}`);
    return (await response.json()) as T;
  };

  return {
    smtp: { host: container.getHost(), port: container.getMappedPort(SMTP_PORT) },
    async messages() {
      const list = await getJson<MailpitListResponse>('/messages');
      // The list is newest first; tests read oldest first.
      const full = await Promise.all(list.messages.map((m) => getJson<MailpitMessageResponse>(`/message/${m.ID}`)));
      return full.reverse().map((m) => ({
        from: { name: m.From.Name, address: m.From.Address },
        to: m.To.map((t) => ({ name: t.Name, address: t.Address })),
        subject: m.Subject,
        text: m.Text,
        html: m.HTML,
      }));
    },
    async clear() {
      const response = await fetch(`${api}/messages`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Mailpit clear answered ${response.status}`);
    },
    async teardown() {
      await container.stop();
    },
  };
}
