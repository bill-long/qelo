import { createSignal } from "solid-js";
import type { Session } from "@/jmap/types";

export const [session, setSession] = createSignal<Session | null>(null);
