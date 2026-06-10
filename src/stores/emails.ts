import { createStore } from "solid-js/store";
import type { Email } from "@/jmap/types";

export const [emails, setEmails] = createStore<Record<string, Email>>({});
