import { Match, Switch } from "solid-js";
import { pushStatus } from "@/stores/sync";

/**
 * A compact indicator for the live push channel, shown in the folder rail. It stays
 * quiet while updates are flowing (`live`/idle) and only surfaces when the connection is
 * being (re)established, so a persistent push failure is visible instead of silent.
 */
export function SyncStatus() {
  return (
    <Switch>
      <Match when={pushStatus() === "reconnecting"}>
        <p class="sync-status is-reconnecting" role="status">
          <span class="sync-status-dot" aria-hidden="true" />
          Reconnecting…
        </p>
      </Match>
      <Match when={pushStatus() === "connecting"}>
        <p class="sync-status" role="status">
          <span class="sync-status-dot" aria-hidden="true" />
          Connecting…
        </p>
      </Match>
    </Switch>
  );
}
