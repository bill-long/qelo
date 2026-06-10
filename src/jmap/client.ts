import type { Session } from "./types";

export class JmapClient {
  constructor(
    private readonly sessionUrl: string,
    private readonly token: string,
  ) {}

  async session(): Promise<Session> {
    const res = await fetch(this.sessionUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Session fetch failed: ${res.status}`);
    return res.json();
  }
}
