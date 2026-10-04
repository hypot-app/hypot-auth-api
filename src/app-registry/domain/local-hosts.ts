/** Hosts for which plain http is acceptable outside production. */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

export interface UrlRuleOptions {
  isProduction: boolean;
}
