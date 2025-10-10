import { SyncAgent } from "agents-sync";
import type { Env } from "../server";
export class Stateful extends SyncAgent<Env> {
  initialState = {
    color: "#3B82F6",
    counter: 0,
    text: ""
  };
}
