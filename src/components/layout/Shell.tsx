import type { JSX } from "solid-js";

export function Shell(props: { children: JSX.Element }) {
  return <div class="shell">{props.children}</div>;
}
