/** Process-wide network defaults. Application configuration is stored in SQLite. */
import { setDefaultResultOrder } from 'node:dns';

// Default DNS resolution to IPv4 first to avoid unreachable IPv6 routes in
// dual-stack environments and Docker bridge networks without IPv6 egress.
try {
  setDefaultResultOrder('ipv4first');
} catch {
  // best effort across node environments
}
