import { isIPv4, isIPv6 } from 'node:net';

/** Shared bucket for requests whose address cannot be determined at all. */
const UNKNOWN_KEY = 'unknown';

/**
 * Parses a valid IPv6 literal into its eight 16-bit groups, or null.
 * A dotted IPv4 tail (`::ffff:1.2.3.4`) is folded into the last two groups.
 */
function ipv6Groups(address: string): number[] | null {
  const bare = address.split('%')[0] ?? '';
  if (!isIPv6(bare)) return null;
  let text = bare;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = text.slice(0, tail.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head = '', rest] = text.split('::');
  const first = head === '' ? [] : head.split(':');
  const last = rest === undefined || rest === '' ? [] : rest.split(':');
  const zeros = rest === undefined ? [] : Array<string>(8 - first.length - last.length).fill('0');
  return [...first, ...zeros, ...last].map((group) => parseInt(group, 16));
}

function normalize(address: string | undefined): string | null {
  if (address === undefined) return null;
  if (isIPv4(address)) return address;
  const groups = ipv6Groups(address);
  if (groups === null) return null;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  // One subscriber usually owns a whole /64 (ADR 37), so only the prefix identifies the client.
  return `${[g0, g1, g2, g3].map((group) => group.toString(16)).join(':')}::/64`;
}

/** The client address as the limiter keys it (ADR 37). */
export class ClientIp {
  private constructor(readonly key: string) {}

  /**
   * @param reported Express `req.ip`, which honors `trust proxy`. It can hold garbage taken from a spoofed header.
   * @param peer The TCP peer address, used when `reported` is missing or malformed.
   */
  static from(reported: string | undefined, peer: string | undefined): ClientIp {
    return new ClientIp(normalize(reported) ?? normalize(peer) ?? UNKNOWN_KEY);
  }
}
