import { createStore } from "solid-js/store";
import type { Mailbox } from "@/jmap/types";

export const [mailboxes, setMailboxes] = createStore<Record<string, Mailbox>>({});
