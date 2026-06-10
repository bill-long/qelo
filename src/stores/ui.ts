import { createSignal } from "solid-js";

export const [selectedMailboxId, setSelectedMailboxId] = createSignal<string | null>(null);
export const [selectedEmailId, setSelectedEmailId] = createSignal<string | null>(null);
