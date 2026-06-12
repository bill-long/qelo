import process from "node:process";
import { JMAP_BASE } from "@/integration/harness";

// The dev server uses a self-signed certificate. Trust it for the local loopback host
// only — NODE_TLS_REJECT_UNAUTHORIZED is process-wide, so never weaken verification when
// the integration target points at a remote server. Match localhost (any case, hosts are
// case-insensitive), IPv4 loopback, and IPv6 loopback `[::1]`.
if (/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(JMAP_BASE)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}
